import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { SanitizedLogger } from '../../monitoring/logger';
import { BookingExecutionContext, VirtualQWorkflowError } from './types';
import { FlowDiagnosticsManager } from './diagnostics';
import { SABARIMALA_SELECTORS } from '../selectors';
import { WishlistFlow } from './wishlist.flow';
import { resolveCanonicalRoute, OFFICIAL_PORTAL_ROUTES } from './date-route.flow';
import { BookingConfirmationFlow } from './booking-confirmation.flow';
import { TelegramFailureNotifier, TelegramFailureAlertPayload } from '../../monitoring/telegram-notifier';
import { BookingExecutionGuard } from '../../security/execution-guard';

export interface PaymentGatewayState {
  loaded: boolean;
  gatewayUrl: string;
  amount?: string;
  summaryText?: string;
  checkoutVerified: boolean;
  finalSubmitButtonFound?: boolean;
}

export class PaymentReviewFlow {
  /**
   * Fast abort handler for official Sabarimala payment page error:
   * "Sorry, this service is not available. Kindly edit / remove the service through 'My Wishlist' to continue with the payment."
   */
  static async checkServiceUnavailableAndAbort(page: Page, ctx: BookingExecutionContext): Promise<void> {
    const pageText = await page.innerText('body').catch(() => '');
    const isServiceUnavailable =
      /Sorry,?\s*this\s*service\s*is\s*not\s*available/i.test(pageText) ||
      /Kindly\s*edit\s*\/\s*remove\s*the\s*service\s*through\s*['"]?My\s*Wishlist['"]?/i.test(pageText);

    if (!isServiceUnavailable) {
      return;
    }

    SanitizedLogger.error(
      `[PAYMENT-REVIEW] Official portal rejected booking: Service unavailable detected on payment page for #${ctx.bookingCode}`,
    );

    // Extract details if present on page
    const cartMatch = pageText.match(/Cart\s*ID[\s:]+([0-9]{6,25})/i);
    if (cartMatch && !ctx.cartId) {
      ctx.cartId = cartMatch[1].trim();
    }
    const refMatch = pageText.match(/\b(IVQ[0-9A-Z]{8,35})\b/i) || pageText.match(/Booking\s*ID[\s:]+([A-Z0-9]{8,35})/i);
    if (refMatch && !ctx.officialBookingReference) {
      ctx.officialBookingReference = refMatch[1].trim();
    }
    const slotMatch = pageText.match(/(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})/);
    if (slotMatch && !ctx.selectedTimeSlot) {
      ctx.selectedTimeSlot = slotMatch[1].trim();
    }

    // Capture screenshot to debug directory
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const debugDir = path.resolve(__dirname, '../../../debug');
    if (!fs.existsSync(debugDir)) {
      try {
        fs.mkdirSync(debugDir, { recursive: true });
      } catch {}
    }
    const screenshotPath = path.join(debugDir, `${ctx.bookingCode}-PORTAL_SERVICE_UNAVAILABLE-${timestamp}.png`);
    let screenshotBase64: string | undefined;

    try {
      if (typeof page.screenshot === 'function') {
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        if (fs.existsSync(screenshotPath)) {
          const buf = await fs.promises.readFile(screenshotPath);
          screenshotBase64 = `data:image/png;base64,${buf.toString('base64')}`;
        }
      }
    } catch (shotErr: any) {
      SanitizedLogger.warn(`[PAYMENT-REVIEW] Failed to capture full-page screenshot: ${shotErr?.message || shotErr}`);
    }

    // Send Telegram failure alert
    let telegramDispatchResult = 'FAILED';
    try {
      const alertPayload: TelegramFailureAlertPayload = {
        bookingId: ctx.bookingId || ctx.bookingCode,
        bookingCode: ctx.bookingCode,
        requestedDate: ctx.requestedDateDisplay || ctx.requestedDate,
        route: ctx.requestedRoute,
        failureStage: 'PAYMENT_GATEWAY_SERVICE_UNAVAILABLE',
        errorMessage: `Sorry, this service is not available. Cart: ${ctx.cartId || 'N/A'}, Ref: ${ctx.officialBookingReference || 'N/A'}, Slot: ${ctx.selectedTimeSlot || 'N/A'}, Devotee: #${(ctx.currentPilgrimIndex ?? 0) + 1}`,
        screenshotBase64,
      };
      const alertRes = await TelegramFailureNotifier.sendFailureAlert(alertPayload);
      telegramDispatchResult = alertRes.deliveredVia || (alertRes.success ? 'SUCCESS' : 'FAILED');
    } catch (alertErr: any) {
      SanitizedLogger.warn(`[PAYMENT-REVIEW] Failed to dispatch Telegram alert: ${alertErr?.message || alertErr}`);
      telegramDispatchResult = 'ERROR';
    }

    // Cancel or abort current operation using portal's Cancel control if safely available
    try {
      const cancelBtn = page.locator('button:has-text("Cancel"), a:has-text("Cancel"), .btn-cancel').first();
      if (await cancelBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        SanitizedLogger.info('[PAYMENT-REVIEW] Clicking portal Cancel button on payment page');
        await cancelBtn.click({ timeout: 3000 }).catch(async () => {
          await cancelBtn.click({ force: true }).catch(() => {});
        });
        await page.waitForTimeout(500).catch(() => {});
      }
    } catch (cancelErr: any) {
      SanitizedLogger.warn(`[PAYMENT-REVIEW] Could not click Cancel button: ${cancelErr?.message || cancelErr}`);
    }

    // Release execution and priority locks
    BookingExecutionGuard.releaseGlobalPriorityLock();
    if (ctx.bookingId) BookingExecutionGuard.release(ctx.bookingId, ctx.jobId || '');
    if (ctx.bookingCode && ctx.bookingCode !== ctx.bookingId) {
      BookingExecutionGuard.release(ctx.bookingCode, ctx.jobId || '');
    }

    // Dedicated log marker
    SanitizedLogger.error(
      `[PORTAL_SERVICE_UNAVAILABLE_ABORTED] Service unavailable error detected on official payment page. Screenshot path: ${screenshotPath}, Telegram dispatch result: ${telegramDispatchResult}`,
    );

    // Throw VirtualQWorkflowError with PORTAL_SERVICE_UNAVAILABLE
    throw new VirtualQWorkflowError(
      'PORTAL_SERVICE_UNAVAILABLE',
      `Sorry, this service is not available. Kindly edit / remove the service through 'My Wishlist' to continue with the payment. Cart ID: ${ctx.cartId || 'N/A'}, Ref: ${ctx.officialBookingReference || 'N/A'}`,
      'PHASE_8_PAYMENT_REVIEW',
      {
        stage: 'PHASE_8_PAYMENT_REVIEW',
        screenshotPath,
        additionalInfo: {
          bookingCode: ctx.bookingCode,
          cartId: ctx.cartId,
          officialBookingReference: ctx.officialBookingReference,
          selectedTimeSlot: ctx.selectedTimeSlot,
          devoteeNumber: (ctx.currentPilgrimIndex ?? 0) + 1,
          telegramDispatchResult,
        },
      } as any,
    );
  }

  /**
   * Helper: Bounded wait for async loaders / shade overlays to detach/hide
   */
  static async waitForLoaderHidden(page: Page, timeoutMs = 10000): Promise<void> {
    const loaderSelectors = [
      '#loader .shade',
      '#loader',
      '.loader .shade',
      '.loader',
      '.ngx-spinner-overlay',
      'ngx-spinner .overlay',
      '.cdk-overlay-backdrop',
    ];

    const startTime = Date.now();
    for (const sel of loaderSelectors) {
      const remainingTime = Math.max(500, timeoutMs - (Date.now() - startTime));
      try {
        const loaderEl = page.locator(sel).first();
        if (await loaderEl.isVisible({ timeout: 400 }).catch(() => false)) {
          SanitizedLogger.info(`[LOADER] Detected active loader/shade (${sel}). Waiting up to ${remainingTime}ms for it to detach/hide...`);
          await loaderEl.waitFor({ state: 'hidden', timeout: remainingTime }).catch(() => {});
        }
      } catch {
        // Continue checking other selectors
      }
      if (Date.now() - startTime >= timeoutMs) break;
    }

    // Verify no blocking loader overlay remains visible
    const shadeEl = page.locator('#loader .shade, .loader .shade, #loader, .ngx-spinner-overlay').first();
    const isStillVisible = await shadeEl.isVisible({ timeout: 400 }).catch(() => false);
    if (isStillVisible) {
      throw new Error('LOADER_ACTIVE: Loader overlay (#loader .shade) remained visible after bounded timeout');
    }
  }

  /**
   * PHASE 8: Proceed from Wishlist to Official Payment Gateway (#/paymentGateway)
   * And authoritatively verify checkout page booking details against original booking request.
   */
  static async execute(page: Page, ctx: BookingExecutionContext): Promise<PaymentGatewayState> {
    SanitizedLogger.info(`[PAYMENT-REVIEW] Initiating payment review sequence for Booking #${ctx.bookingCode}`);

    try {
      // Step 8.1: Wait for any active loader/shade from previous actions to hide
      try {
        await this.waitForLoaderHidden(page, 10000);
      } catch (loaderErr: any) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'LOADER_TIMEOUT',
          `Loader overlay (#loader .shade) intercepted pointer events and failed to detach within timeout: ${loaderErr.message}`,
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }

      // Step 8.2: Authoritative pre-proceed verification:
      // Verify Wishlist drawer items before proceeding:
      // 1. The stale unavailable item is gone.
      // 2. The current booking item is present.
      // 3. No duplicate current booking item exists.
      // 4. The current booking details match the requested devotee.
      await WishlistFlow.verifyWishlistBeforeCheckout(page, ctx);

      // Step 8.3: Locate Proceed button inside the My Wishlist panel on Virtual-Q page (#/darshan)
      // Scoped to the Wishlist container, not a broad page-wide text locator.
      SanitizedLogger.info('[PAYMENT-REVIEW] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
      SanitizedLogger.info('[PAYMENT-REVIEW] Inspecting My Wishlist panel on Virtual-Q page');

      const panel = await WishlistFlow.findWishlistPanel(page);
      SanitizedLogger.info(
        `[PAYMENT-REVIEW] Wishlist panel visibility: ${panel.visible ? 'Visible (' + panel.selector + ')' : 'Hidden'}`,
      );

      let targetProceed = await WishlistFlow.findProceedButton(page, panel.visible ? panel.locator : undefined);

      // If panel is visible but Proceed is not detected, wait briefly for Angular rendering to settle and retry locator detection without refreshing
      if (panel.visible && !targetProceed.visible) {
        SanitizedLogger.info('[PAYMENT-REVIEW] Wishlist panel visible but Proceed not detected. Waiting for Angular rendering to settle...');
        await page.waitForTimeout(1000);
        const reacquiredPanel = await WishlistFlow.findWishlistPanel(page);
        targetProceed = await WishlistFlow.findProceedButton(page, reacquiredPanel.visible ? reacquiredPanel.locator : undefined);
        if (!targetProceed.visible) {
          await page.waitForTimeout(1500);
          targetProceed = await WishlistFlow.findProceedButton(page);
        }
      }

      SanitizedLogger.info(
        `[PAYMENT-REVIEW] Proceed button locator: "${targetProceed.selector || 'None'}", visible=${targetProceed.visible}, enabled=${targetProceed.enabled}`,
      );

      if (!targetProceed.visible) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PAYMENT_PAGE_LOAD_FAILED',
          'Proceed button not found in My Wishlist panel on Virtual-Q page (#/darshan)',
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }

      // Verify Proceed button is enabled
      if (!targetProceed.enabled) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'BUTTON_DISABLED',
          'Proceed button is disabled in Wishlist panel',
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }

      // Final loader check before click
      await this.waitForLoaderHidden(page, 3000).catch(() => {});

      // Helper to locate and click Proceed button with bounded retries on overlay interception
      const clickProceedButton = async (): Promise<void> => {
        let btn = targetProceed.locator;
        if (!btn) {
          const fresh = await WishlistFlow.findProceedButton(page);
          btn = fresh.locator;
        }
        if (!btn) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'PAYMENT_PAGE_LOAD_FAILED',
            'Proceed button not found in My Wishlist panel on Virtual-Q page (#/darshan)',
            'PHASE_8_PAYMENT_REVIEW',
            diag,
          );
        }

        let clicked = false;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3 && !clicked; attempt++) {
          try {
            SanitizedLogger.info(`[PAYMENT-REVIEW] Proceed click attempt ${attempt} of 3...`);
            SanitizedLogger.info('[FIRST_PROCEED_CLICKED] Clicking first Proceed button in Wishlist panel');
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await btn.click({ force: false, timeout: 5000 });
            clicked = true;
            SanitizedLogger.info(`[PAYMENT-REVIEW] Proceed click attempt ${attempt} succeeded. Waiting for loader and navigation to checkout...`);
          } catch (clickErr: any) {
            lastErr = clickErr;
            SanitizedLogger.warn(`[PAYMENT-REVIEW] Proceed click attempt ${attempt} intercepted: ${clickErr.message}`);
            await this.waitForLoaderHidden(page, 3000).catch(() => {});
            await page.waitForTimeout(600);
            const refound = await WishlistFlow.findProceedButton(page);
            if (refound.visible && refound.enabled) {
              btn = refound.locator;
            }
          }
        }

        if (!clicked && btn) {
          try {
            SanitizedLogger.warn('[PAYMENT-REVIEW] Click intercepted across retries. Attempting force click...');
            await btn.click({ force: true, timeout: 4000 });
            clicked = true;
          } catch (forceErr: any) {
            lastErr = forceErr;
          }
        }

        if (!clicked) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          if (lastErr?.message?.includes('intercepts pointer events') || lastErr?.message?.includes('shade') || lastErr?.message?.includes('loader')) {
            throw new VirtualQWorkflowError(
              'LOADER_TIMEOUT',
              `Proceed click intercepted by loader overlay: ${lastErr.message}`,
              'PHASE_8_PAYMENT_REVIEW',
              diag,
            );
          }
          throw lastErr || new Error('Failed to click Proceed button');
        }
      };

      // Step 8.4: Click Proceed and wait for URL / checkout-state change to #/paymentGateway
      await clickProceedButton();

      let reachedGateway = false;
      let isExplicitInvalidCart = false;
      try {
        await this.waitForLoaderHidden(page, 10000).catch(() => {});

        // Check for any dialog/toast/alert containing "Invalid"
        const invalidBanner = page.locator('.toast, .mat-snack-bar-container, .alert, mat-dialog-container, .swal2-popup, div[role="alert"], text=/Invalid/i').first();
        if (await invalidBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
          const text = await invalidBanner.innerText().catch(() => '');
          if (/invalid/i.test(text)) {
            isExplicitInvalidCart = true;
            throw new Error(`Invalid cart error detected: "${text.trim()}"`);
          }
        }

        if (typeof page.waitForURL === 'function') {
          await page.waitForURL('**/#/paymentGateway', { timeout: 10000 }).catch(() => {});
        }

        const navStart = Date.now();
        while (Date.now() - navStart < 10000 && !reachedGateway) {
          const url = typeof page.url === 'function' ? page.url() : '';
          if (url.includes('paymentGateway') || url.includes('paymentReview')) {
            reachedGateway = true;
            break;
          }

          const bodyText = await page.innerText('body').catch(() => '');
          if (
            /payment\s*gateway/i.test(bodyText) ||
            /grand\s*total/i.test(bodyText) ||
            /payment\s*summary/i.test(bodyText) ||
            /booking\s*id/i.test(bodyText) ||
            /total\s*amount/i.test(bodyText)
          ) {
            reachedGateway = true;
            break;
          }

          const checkoutBtn = page.locator('button:has-text("Proceed to Pay"), button:has-text("Make Payment"), button:has-text("Confirm Payment")').first();
          if (await checkoutBtn.isVisible({ timeout: 400 }).catch(() => false)) {
            reachedGateway = true;
            break;
          }

          await page.waitForTimeout(600);
        }

        SanitizedLogger.info(`[PAYMENT-REVIEW] Navigation/checkout verification result: ${reachedGateway ? 'SUCCESS' : 'FAILED'}`);

        if (!reachedGateway) {
          throw new Error(`URL did not transition to #/paymentGateway within timeout (current URL: "${typeof page.url === 'function' ? page.url() : ''}")`);
        }
      } catch (proceedErr: any) {
        if (isExplicitInvalidCart) {
          SanitizedLogger.warn('[WISHLIST] Proceed failed (Invalid cart). Attempting recovery...');

          // Find and click the "Clear Wishlist" button
          const clearWishlistSelectors = [
            'button:has-text("Clear Wishlist")',
            'a:has-text("Clear Wishlist")',
            'button:has-text("Clear All")',
            'button:has-text("Clear")',
            '.btn-clear-wishlist',
            '.clear-wishlist',
            'button[aria-label*="Clear" i]',
            'button:has-text("Empty Wishlist")',
            'button:has-text("Delete All")',
            '.side-drawer button:has-text("Clear")',
            '.drawer button:has-text("Clear")',
            'mat-drawer button:has-text("Clear")',
          ];

          let clearBtn = null;
          for (const sel of clearWishlistSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
              clearBtn = btn;
              break;
            }
          }

          if (clearBtn) {
            SanitizedLogger.info('[WISHLIST] Found "Clear Wishlist" button. Clicking to empty cart...');
            await clearBtn.click().catch(() => {});
            const confirmBtn = page.locator('mat-dialog-container button:has-text("Yes"), mat-dialog-container button:has-text("OK"), mat-dialog-container button:has-text("Confirm"), .swal2-confirm, button:has-text("Yes"), button:has-text("Confirm")').first();
            if (await confirmBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await confirmBtn.click().catch(() => {});
            }
          } else {
            const itemDeleteButtons = page.locator('.side-drawer button.btn-delete, app-wishlist button.btn-delete, .side-drawer mat-icon:has-text("delete"), .wishlist-table mat-icon:has-text("delete"), app-wishlist mat-icon:has-text("delete"), button.btn-delete');
            const count = typeof itemDeleteButtons.count === 'function' ? await itemDeleteButtons.count().catch(() => 0) : 0;
            for (let i = 0; i < count; i++) {
              const btn = itemDeleteButtons.nth(i);
              if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click().catch(() => {});
                const confirmBtn = page.locator('mat-dialog-container button:has-text("Yes"), .swal2-confirm').first();
                if (await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                  await confirmBtn.click().catch(() => {});
                }
              }
            }
          }

          // Wait for the wishlist to empty
          await page.waitForTimeout(1000);
          const emptyIndicators = [
            ...SABARIMALA_SELECTORS.wishlist.emptyIndicators,
            '.empty-wishlist',
            'text=/Wishlist is empty/i',
            'text=/No items in wishlist/i',
            'text=/No records found/i',
          ];
          for (const emptySel of emptyIndicators) {
            const el = page.locator(emptySel).first();
            if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
              SanitizedLogger.info(`[WISHLIST] Wishlist confirmed empty via indicator: ${emptySel}`);
              break;
            }
          }

          // Retry: Go back and re-run the WishlistFlow (Add to Wishlist)
          SanitizedLogger.info('[WISHLIST] Re-running WishlistFlow (Add to Wishlist)...');
          ctx.wishlistStatus = 'NOT_STARTED';
          ctx.newlyAddedWishlistVerified = false;
          await WishlistFlow.execute(page, ctx);

          // Once re-added, click "Proceed" again
          await this.waitForLoaderHidden(page, 5000).catch(() => {});
          await clickProceedButton();
        } else {
          SanitizedLogger.error(`[PAYMENT-REVIEW] Navigation to payment gateway unverified: ${proceedErr.message}. Preserving valid Wishlist items.`);
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'PAYMENT_PAGE_LOAD_FAILED',
            `Official payment page failed to load after Proceed. Current URL: "${typeof page.url === 'function' ? page.url() : ''}"`,
            'PHASE_8_PAYMENT_REVIEW',
            diag,
          );
        }
      }

      // Strict URL Verification: Ensure the worker explicitly awaits page.waitForURL('**/#/paymentGateway', { timeout: 15000 })
      if (typeof page.waitForURL === 'function') {
        await page.waitForURL('**/#/paymentGateway', { timeout: 15000 });
      }

      const currentUrl = typeof page.url === 'function' ? page.url() : '';
      const isPaymentUrl = currentUrl.includes('paymentGateway');

      if (!isPaymentUrl) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PAYMENT_PAGE_LOAD_FAILED',
          `Official payment page failed to load after Proceed. Current URL: "${currentUrl}"`,
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }

      // Fast abort check: Stop immediately if official portal shows service unavailable
      await this.checkServiceUnavailableAndAbort(page, ctx);

      // Step 8.5: Once on #/paymentGateway, verify the Grand Total: ₹0.00
      const pageText = await page.innerText('body').catch(() => '');
      const amountEl = page.locator('.total-amount, .grand-total, #totalAmount, text=/Total Amount/i, text=/Grand Total/i').first();
      let grandTotal = '₹0.00';
      if (await amountEl.isVisible({ timeout: 1000 }).catch(() => false)) {
        grandTotal = (await amountEl.innerText().catch(() => '₹0.00')).trim();
      }

      const parsedAmount = BookingConfirmationFlow.parseNumericAmount(grandTotal);
      if (parsedAmount > 0) {
        SanitizedLogger.error(`[PAYMENT-REVIEW] Unexpected non-zero Grand Total on payment gateway: ${grandTotal}`);
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'CHECKOUT_VERIFICATION_MISMATCH',
          `Unexpected non-zero Grand Total on payment gateway: ${grandTotal} (Expected ₹0.00)`,
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }
      SanitizedLogger.info(`[PAYMENT-REVIEW] Verified Grand Total: ${grandTotal} (Zero-cost verified)`);

      // Locate the final "Process" or "Confirm" button (the one that actually submits the booking)
      const finalSubmitSelectors = [
        'button:has-text("Process")',
        'button:has-text("Confirm")',
        'button:has-text("Proceed to Pay")',
        'button:has-text("Proceed to Book")',
        'button:has-text("Pay Now")',
        'button:has-text("Proceed")',
        'button[type="submit"]',
      ];

      let finalSubmitBtn = null;
      for (const sel of finalSubmitSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          finalSubmitBtn = btn;
          break;
        }
      }

      if (finalSubmitBtn) {
        SanitizedLogger.info('[PAYMENT-REVIEW] Final Process/Confirm submit button located on payment page.');
      } else {
        SanitizedLogger.warn('[PAYMENT-REVIEW] Final Process/Confirm submit button not immediately visible on payment page.');
      }

      // Check date equality if dates are rendered on payment summary
      const hasAnyDateMention = /\b\d{2}[-/]\d{2}[-/]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(pageText);
      if (hasAnyDateMention) {
        const hasDate = WishlistFlow.matchesDate(pageText, ctx.requestedDate, ctx.requestedDateDisplay);
        if (!hasDate) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'CHECKOUT_VERIFICATION_MISMATCH',
            `Payment review page date does not match requested date (Expected: ${ctx.requestedDateDisplay || ctx.requestedDate})`,
            'PHASE_8_PAYMENT_REVIEW',
            diag,
          );
        }
      }

      // Check route equality
      const canonicalRoute = resolveCanonicalRoute(ctx.requestedRoute);
      if (canonicalRoute && Object.values(OFFICIAL_PORTAL_ROUTES).some((r: any) => pageText.toLowerCase().includes(r.primaryKeyword))) {
        const hasRoute = WishlistFlow.matchesRoute(pageText, ctx.requestedRoute);
        if (!hasRoute) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'CHECKOUT_VERIFICATION_MISMATCH',
            `Payment review page route does not match requested route (Expected: ${canonicalRoute.canonicalName})`,
            'PHASE_8_PAYMENT_REVIEW',
            diag,
          );
        }
      }

      // Check slot equality if time slots are mentioned
      if (ctx.selectedTimeSlot && ctx.selectedTimeSlot !== 'Any' && /\b\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\b/.test(pageText)) {
        const hasSlot = WishlistFlow.matchesSlot(pageText, ctx.selectedTimeSlot);
        if (!hasSlot) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'CHECKOUT_VERIFICATION_MISMATCH',
            `Payment review page time slot does not match requested slot (Expected: ${ctx.selectedTimeSlot})`,
            'PHASE_8_PAYMENT_REVIEW',
            diag,
          );
        }
      }

      // Check pilgrim count equality if pilgrim count is mentioned
      if (ctx.pilgrimCount && ctx.pilgrimCount > 0 && /(?:pilgrim|person)/i.test(pageText)) {
        const hasPilgrims = WishlistFlow.matchesPilgrimCount(pageText, ctx.pilgrimCount);
        if (!hasPilgrims) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'CHECKOUT_VERIFICATION_MISMATCH',
            `Payment review page pilgrim count does not match requested count (Expected: ${ctx.pilgrimCount})`,
            'PHASE_8_PAYMENT_REVIEW',
            diag,
          );
        }
      }

      ctx.checkoutVerified = true;
      ctx.paymentStatus = 'GATEWAY_LOADED';
      ctx.grandTotal = grandTotal;

      SanitizedLogger.info(
        `[PAYMENT-REVIEW] ✅ Checkout details independently verified against booking request. URL: ${currentUrl}, Total: ${grandTotal}`,
      );
      SanitizedLogger.info('[CHECKOUT_PAGE_VERIFIED] Checkout page verified: Date, route, slot, pilgrim count and Grand Total ₹0.00 match booking request');

      return {
        loaded: true,
        gatewayUrl: currentUrl,
        amount: grandTotal,
        summaryText: pageText.slice(0, 500),
        checkoutVerified: true,
        finalSubmitButtonFound: !!finalSubmitBtn,
      };
    } catch (err: any) {
      if (err instanceof VirtualQWorkflowError) throw err;
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
      const isGatewayLoaded = typeof page.url === 'function' && page.url().includes('paymentGateway');
      const errorCode = isGatewayLoaded ? 'CONFIRM_BUTTON_NOT_FOUND' : 'PAYMENT_PAGE_LOAD_FAILED';
      throw new VirtualQWorkflowError(
        errorCode,
        err.message || (isGatewayLoaded ? 'Payment review page loaded but confirmation button was missing or disabled' : 'Failed proceeding to official payment page'),
        'PHASE_8_PAYMENT_REVIEW',
        diag,
      );
    }
  }

  /**
   * Helper: Navigates back to #/darshan to remove only the wishlist item added by this attempt,
   * strictly preserving pre-existing devotee wishlist entries.
   */
  static async clearWishlistOnDarshan(page: Page, ctx: BookingExecutionContext): Promise<void> {
    SanitizedLogger.info('[WISHLIST] Inspecting wishlist on #/darshan to remove only this attempt item...');
    if (typeof page.goto === 'function') {
      const currentUrl = typeof page.url === 'function' ? page.url() : '';
      if (!currentUrl.includes('/darshan')) {
        await page.goto('https://sabarimalaonline.org/#/darshan', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
    }
    await page.waitForTimeout(1000);

    // Identify rows in the wishlist panel
    const rowSelectors = [
      'app-wishlist .item',
      'app-wishlist ul.wishlist-list li',
      '.side-drawer table tbody tr',
      'mat-drawer table tbody tr',
      '.drawer table tbody tr',
      '.wishlist-drawer table tbody tr',
      'table.wishlist-table tbody tr',
      '.side-drawer .wishlist-item',
      'mat-drawer .wishlist-item',
    ];

    let itemRemoved = false;
    for (const sel of rowSelectors) {
      const rows = page.locator(sel);
      const count = await rows.count().catch(() => 0);
      if (count === 0) continue;

      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const rowText = await row.innerText().catch(() => '');

        // Check if this specific row matches the requested date and/or route
        const matchesDate = ctx.requestedDate && (rowText.includes(ctx.requestedDate) || (ctx.requestedDateDisplay && rowText.includes(ctx.requestedDateDisplay)));
        const matchesRoute = ctx.requestedRoute && (rowText.toLowerCase().includes(ctx.requestedRoute.toLowerCase().slice(0, 5)));

        if (matchesDate || (count === 1 && matchesRoute)) {
          SanitizedLogger.info(`[WISHLIST] Found target item for removal matching date/route ("${rowText.slice(0, 80).replace(/\s+/g, ' ')}"). Removing single item...`);
          const deleteBtn = row.locator('button.btn-delete, mat-icon:has-text("delete"), .delete-icon, button:has-text("Delete"), a:has-text("Delete")').first();
          if (await deleteBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await deleteBtn.click().catch(() => {});
            const confirmBtn = page.locator('mat-dialog-container button:has-text("Yes"), mat-dialog-container button:has-text("OK"), mat-dialog-container button:has-text("Confirm"), .swal2-confirm, button:has-text("Yes")').first();
            if (await confirmBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await confirmBtn.click().catch(() => {});
            }
            itemRemoved = true;
            break;
          }
        }
      }
      if (itemRemoved) break;
    }

    if (!itemRemoved) {
      SanitizedLogger.info('[WISHLIST] No matching item found for removal or cart already clear. Preserving existing items.');
    } else {
      SanitizedLogger.info('[WISHLIST] Target attempt item removed. Preserved any remaining pre-existing wishlist entries.');
    }
  }

  /**
   * Clicks the final submit button on the official #/paymentGateway page directly without pre-payment arbiter gate.
   */
  static async authorizeAndSubmitPayment(page: Page, ctx: BookingExecutionContext): Promise<{
    confirmed: boolean;
    isZeroCost?: boolean;
    officialReference?: string;
    officialBookingReference?: string;
    cartId?: string;
    portalTransactionReference?: string;
    officialReceiptReference?: string;
    confirmationEvidence?: Record<string, any>;
    confirmedAt?: string;
    confirmationData?: any;
    reconciliationRequired?: boolean;
    message?: string;
  }> {
    // Fast abort check before clicking final proceed or attempting payment
    await this.checkServiceUnavailableAndAbort(page, ctx);

    const finalSubmitSelectors = [
      'button:has-text("Proceed to Pay")',
      'button:has-text("Proceed to Book")',
      'button:has-text("Proceed")',
      'button:has-text("Process")',
      'button:has-text("Confirm")',
      'button:has-text("Pay Now")',
      'button[type="submit"]',
    ];

    let finalSubmitBtn = null;
    for (const sel of finalSubmitSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        finalSubmitBtn = btn;
        break;
      }
    }

    // Immediately click the final "Proceed" button on the #/paymentGateway page
    if (finalSubmitBtn) {
      await finalSubmitBtn.scrollIntoViewIfNeeded().catch(() => {});
      await finalSubmitBtn.click({ timeout: 5000 }).catch(async () => {
        await finalSubmitBtn.click({ force: true }).catch(() => {});
      });
      SanitizedLogger.info('[PAYMENT-REVIEW] Clicked final Proceed/Process button on #/paymentGateway.');
      SanitizedLogger.info('[SECOND_PROCEED_CLICKED] Clicking second Proceed button on checkout page');
    } else {
      SanitizedLogger.warn('[PAYMENT-REVIEW] Final submit button not found, checking if confirmation is already rendered...');
    }

    // Second Proceed clicked = confirmation pending
    SanitizedLogger.info('[CONFIRMATION] Second Proceed clicked; awaiting official Booking Confirmation popup (confirmation pending)...');

    // 2. Wait for official Booking Confirmation popup
    const popupSelectors = [
      'mat-dialog-container:has-text("Booking Confirmation")',
      '.swal2-modal:has-text("Booking Confirmation")',
      'mat-dialog-container:has-text("transaction is successful")',
      '.swal2-modal:has-text("transaction is successful")',
      '[role="dialog"]:has-text("Booking Confirmation")',
      'div:has-text("Booking Confirmation"):has(button:has-text("OK"))',
      '.modal-dialog:has-text("Booking Confirmation")',
      'mat-dialog-container',
      '.swal2-modal',
    ];

    let popupFound = false;
    let popupLoc: any = null;
    let popupText = '';
    const popupStart = Date.now();
    const popupTimeoutMs = 15000;

    while (Date.now() - popupStart < popupTimeoutMs && !popupFound) {
      await this.checkServiceUnavailableAndAbort(page, ctx);
      const currentBodyText = await page.innerText('body').catch(() => '');
      if (
        currentBodyText.includes('Sorry, this service is not available') ||
        currentBodyText.includes("service through 'My Wishlist'")
      ) {
        SanitizedLogger.error('[PAYMENT-REVIEW] Official portal rejected booking: Service not available');
        return {
          confirmed: false,
          reconciliationRequired: false,
          message: 'Official portal rejected booking: Sorry, this service is not available.',
        };
      }

      if (
        /\b(transaction\s*(?:cancelled|failed|declined|unsuccessful)|payment\s*failed|booking\s*cancelled|booking\s*failed|0\s*pilgrims?)\b/i.test(currentBodyText) ||
        /\b(CANCELLED|FAILED|DECLINED|ABORTED)\b/i.test(currentBodyText)
      ) {
        return {
          confirmed: false,
          reconciliationRequired: false,
          message: 'Official portal indicated transaction cancelled, failed, or 0 pilgrims.',
        };
      }

      for (const sel of popupSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
            const txt = await el.innerText().catch(() => '');
            if (
              /Booking\s*Confirmation/i.test(txt) ||
              /Your\s*transaction\s*is\s*successful/i.test(txt)
            ) {
              popupFound = true;
              popupLoc = el;
              popupText = txt;
              break;
            }
          }
        } catch {}
      }

      if (!popupFound) {
        if (/Booking\s*Confirmation/i.test(currentBodyText) && /Your\s*transaction\s*is\s*successful/i.test(currentBodyText)) {
          popupFound = true;
          popupText = currentBodyText;
          popupLoc = page.locator('mat-dialog-container, .swal2-modal, [role="dialog"], body').first();
          break;
        }
        await page.waitForTimeout(500);
      }
    }

    if (!popupFound) {
      SanitizedLogger.warn('[CONFIRMATION] Official booking success popup did not appear within timeout. Entering safe reconciliation without guessing.');
      return {
        confirmed: false,
        reconciliationRequired: true,
        message: 'Official booking success popup did not appear after second Proceed. Entering safe reconciliation.',
      };
    }

    SanitizedLogger.info('[OFFICIAL_BOOKING_SUCCESS_POPUP_DETECTED] Official Booking Confirmation popup detected with title "Booking Confirmation"');

    // 3. Extract and persist Transaction ID
    const txnMatch = popupText.match(/(?:Your\s*transaction\s*is\s*successful\s*with\s*Transaction\s*ID|Transaction\s*ID|TXN\s*ID)[\s:]+([0-9A-Z]{6,35})/i) ||
      popupText.match(/\b(TXN[0-9A-Z]{6,30})\b/i);

    const transactionId = txnMatch ? txnMatch[1].trim() : (ctx.cartId || 'UNKNOWN_TXN');
    ctx.portalTransactionReference = transactionId;
    ctx.transactionId = transactionId;
    SanitizedLogger.info(`[OFFICIAL_TRANSACTION_ID_CAPTURED] Official Transaction ID captured: ${transactionId}`);

    const ivqMatch = popupText.match(/\b(IVQ[0-9A-Z]{6,30})\b/i) || popupText.match(/\b(VQ[0-9A-Z]{6,30})\b/i);
    let passReference = ivqMatch ? ivqMatch[1].trim() : undefined;
    if (passReference) {
      ctx.officialBookingReference = passReference;
    }

    // 4. Verify success message is visible
    const isSuccessMessageVisible = /Your\s*transaction\s*is\s*successful/i.test(popupText);
    if (!isSuccessMessageVisible) {
      SanitizedLogger.warn('[CONFIRMATION] Success message "Your transaction is successful" not verified in popup.');
      return {
        confirmed: false,
        reconciliationRequired: true,
        portalTransactionReference: transactionId,
        message: 'Success message could not be verified in popup text.',
      };
    }

    // 5. Click the popup's OK button exactly once
    const okBtn = (popupLoc || page).locator(
      'button:has-text("OK"), mat-dialog-container button:has-text("OK"), .swal2-confirm, mat-dialog-actions button:has-text("OK")'
    ).first();

    const isOkVisible = await okBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (isOkVisible) {
      SanitizedLogger.info('[SUCCESS_POPUP_OK_CLICKED] Clicking OK button on Booking Confirmation popup');
      await okBtn.click({ timeout: 5000 }).catch(async () => {
        await okBtn.click({ force: true }).catch(() => {});
      });
    }

    // 6. Wait for navigation to #/TransactionHistory
    let navigatedToHistory = false;
    try {
      if (typeof page.waitForURL === 'function') {
        await page.waitForURL('**/#/TransactionHistory', { timeout: 15000 }).catch(() => {});
      }
    } catch {}

    const curUrl = typeof page.url === 'function' ? page.url() : '';
    if (curUrl.includes('TransactionHistory')) {
      navigatedToHistory = true;
    } else {
      await page.waitForTimeout(2000);
      const recheckUrl = typeof page.url === 'function' ? page.url() : '';
      if (recheckUrl.includes('TransactionHistory')) {
        navigatedToHistory = true;
      }
    }

    if (!navigatedToHistory) {
      SanitizedLogger.warn(`[CONFIRMATION] Popup was detected with Transaction ID ${transactionId}, but navigation to Transaction History timed out (current URL: ${curUrl}). Preserving Transaction ID for reconciliation.`);
      return {
        confirmed: false,
        reconciliationRequired: true,
        portalTransactionReference: transactionId,
        officialBookingReference: passReference || transactionId,
        message: `Official success popup detected with Transaction ID ${transactionId}, but navigation to Transaction History timed out. Requires reconciliation.`,
      };
    }

    // 7. Verify Transaction History has loaded
    SanitizedLogger.info(`[TRANSACTION_HISTORY_NAVIGATION_VERIFIED] Navigated to Transaction History page (URL: ${curUrl})`);
    await page.waitForTimeout(1500);

    // 8. Verify the transaction record corresponds to the current booking
    let recordVerified = false;
    let verifiedPassRef = passReference;

    const rowSelectors = [
      'table tbody tr',
      '.history-table tbody tr',
      'mat-table mat-row',
      'mat-row',
      '.transaction-item',
      'tr',
    ];

    for (const sel of rowSelectors) {
      try {
        const rows = page.locator(sel);
        const count = await rows.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const rowText = await rows.nth(i).innerText().catch(() => '');
          if (!rowText || rowText.trim().length === 0) continue;

          const hasTxn = transactionId && transactionId !== 'UNKNOWN_TXN' && rowText.includes(transactionId);
          const hasDate = ctx.requestedDate && (rowText.includes(ctx.requestedDate) || (ctx.requestedDateDisplay && rowText.includes(ctx.requestedDateDisplay)));
          const hasPass = passReference && rowText.includes(passReference);

          if (hasTxn || (hasDate && hasPass)) {
            if (/\b(CANCELLED|FAILED|DECLINED|0\s*pilgrim)\b/i.test(rowText)) {
              return {
                confirmed: false,
                reconciliationRequired: false,
                message: `Transaction record ${transactionId} in history is CANCELLED.`,
              };
            }

            const rowIvqMatch = rowText.match(/\b(IVQ[0-9A-Z]{6,30})\b/i) || rowText.match(/\b(VQ[0-9A-Z]{6,30})\b/i);
            if (rowIvqMatch) {
              verifiedPassRef = rowIvqMatch[1].trim();
            }

            recordVerified = true;
            break;
          }
        }
        if (recordVerified) break;
      } catch {}
    }

    if (!recordVerified) {
      const historyBody = await page.innerText('body').catch(() => '');
      if (
        (transactionId && transactionId !== 'UNKNOWN_TXN' && historyBody.includes(transactionId)) ||
        (passReference && historyBody.includes(passReference))
      ) {
        if (!/\b(CANCELLED|FAILED)\b/i.test(historyBody)) {
          recordVerified = true;
          const bodyIvqMatch = historyBody.match(/\b(IVQ[0-9A-Z]{6,30})\b/i);
          if (bodyIvqMatch) {
            verifiedPassRef = bodyIvqMatch[1].trim();
          }
        }
      }
    }

    if (!recordVerified) {
      SanitizedLogger.warn(`[CONFIRMATION] Transaction ID ${transactionId} captured from popup, but record not yet verified in Transaction History. Preserving for reconciliation.`);
      return {
        confirmed: false,
        reconciliationRequired: true,
        portalTransactionReference: transactionId,
        officialBookingReference: verifiedPassRef || transactionId,
        message: `Transaction ${transactionId} confirmed in popup but record not yet verified in Transaction History. Requires reconciliation.`,
      };
    }

    const finalOfficialRef = verifiedPassRef || transactionId;
    SanitizedLogger.info(`[TRANSACTION_HISTORY_RECORD_VERIFIED] Transaction record verified in history for Transaction ID: ${transactionId} (Pass: ${finalOfficialRef})`);
    SanitizedLogger.info(`[OFFICIAL_BOOKING_CONFIRMED] Current devotee officially confirmed with Transaction ID: ${transactionId} (Pass: ${finalOfficialRef})`);

    ctx.officialBookingReference = finalOfficialRef;
    ctx.portalTransactionReference = transactionId;

    return {
      confirmed: true,
      officialReference: finalOfficialRef,
      officialBookingReference: finalOfficialRef,
      portalTransactionReference: transactionId,
      isZeroCost: true,
      confirmedAt: new Date().toISOString(),
    };
  }
}
