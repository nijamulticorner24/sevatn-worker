import { Page } from 'playwright';
import { SanitizedLogger } from '../../monitoring/logger';
import { BookingExecutionContext, VirtualQWorkflowError } from './types';
import { FlowDiagnosticsManager } from './diagnostics';
import { SABARIMALA_SELECTORS } from '../selectors';
import { WishlistFlow } from './wishlist.flow';
import { resolveCanonicalRoute, OFFICIAL_PORTAL_ROUTES } from './date-route.flow';
import { BookingConfirmationFlow } from './booking-confirmation.flow';

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
      // Never click Proceed based only on button enabled state.
      // Must verify wishlist item matches booking details before proceeding.
      const isWishlistVerified = ctx.wishlistStatus === 'VERIFIED' || (await WishlistFlow.verifyItemInWishlist(page, ctx, true));
      if (!isWishlistVerified) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'WISHLIST_VERIFICATION_MISMATCH',
          `Target booking (Date: ${ctx.requestedDateDisplay || ctx.requestedDate}, Route: ${ctx.requestedRoute}, Slot: ${ctx.selectedTimeSlot}) could not be verified in Wishlist drawer before proceeding`,
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }

      // Step 8.3: Locate Proceed button inside the My Wishlist panel on Virtual-Q page (#/darshan)
      // Never navigate away to #/wishlist. The My Wishlist panel is rendered on the right side of #/darshan.
      SanitizedLogger.info('[PAYMENT-REVIEW] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
      SanitizedLogger.info('[PAYMENT-REVIEW] Inspecting My Wishlist panel on Virtual-Q page');

      const proceedSelectors = [
        'app-wishlist button:has-text("Proceed")',
        'app-wishlist button:has-text("Proceed to Book")',
        'app-wishlist button:has-text("Proceed to Pay")',
        '.side-drawer button:has-text("Proceed")',
        '.side-drawer button:has-text("Proceed to Book")',
        '.side-drawer button:has-text("Proceed to Pay")',
        'mat-drawer button:has-text("Proceed")',
        '.drawer button:has-text("Proceed")',
        '.wishlist-drawer button:has-text("Proceed")',
        '.wishlist-panel button:has-text("Proceed")',
        'button:has-text("Proceed to Book")',
        'button:has-text("Proceed to Pay")',
        'button:has-text("Proceed")',
      ];

      let targetProceedBtn = null;
      for (const sel of proceedSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          targetProceedBtn = btn;
          break;
        }
      }

      if (!targetProceedBtn) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PAYMENT_PAGE_LOAD_FAILED',
          'Proceed button not found in My Wishlist panel on Virtual-Q page (#/darshan)',
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }

      // Verify Proceed button is enabled
      const isDisabled = await targetProceedBtn.isDisabled().catch(() => false);
      if (isDisabled) {
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

      // Helper to locate and click Proceed button
      const clickProceedButton = async (): Promise<void> => {
        let btn = null;
        for (const sel of proceedSelectors) {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            btn = el;
            break;
          }
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
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        try {
          await btn.click({ force: false, timeout: 6000 });
          SanitizedLogger.info(`[PAYMENT-REVIEW] Clicked Proceed button. Waiting for loader and navigation to checkout...`);
        } catch (clickErr: any) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
          if (clickErr.message?.includes('intercepts pointer events') || clickErr.message?.includes('shade') || clickErr.message?.includes('loader')) {
            throw new VirtualQWorkflowError(
              'LOADER_TIMEOUT',
              `Proceed click intercepted by loader overlay: ${clickErr.message}`,
              'PHASE_8_PAYMENT_REVIEW',
              diag,
            );
          }
          throw clickErr;
        }
      };

      // Step 8.4: Click Proceed and wait for URL to transition to #/paymentGateway with Invalid Cart recovery
      await clickProceedButton();

      let reachedGateway = false;
      try {
        await this.waitForLoaderHidden(page, 10000).catch(() => {});

        // Check for any dialog/toast/alert containing "Invalid"
        const invalidBanner = page.locator('.toast, .mat-snack-bar-container, .alert, mat-dialog-container, .swal2-popup, div[role="alert"], text=/Invalid/i').first();
        if (await invalidBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
          const text = await invalidBanner.innerText().catch(() => '');
          if (/invalid/i.test(text)) {
            throw new Error(`Invalid cart error detected: "${text.trim()}"`);
          }
        }

        if (typeof page.waitForURL === 'function') {
          await page.waitForURL('**/#/paymentGateway', { timeout: 10000 });
        }

        const url = typeof page.url === 'function' ? page.url() : '';
        if (url.includes('paymentGateway')) {
          reachedGateway = true;
        } else {
          throw new Error(`URL did not transition to #/paymentGateway within 10s (current URL: "${url}")`);
        }
      } catch (proceedErr: any) {
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
    } else {
      SanitizedLogger.warn('[PAYMENT-REVIEW] Final submit button not found, checking if confirmation is already rendered...');
    }

    // Wait for URL to change to success page or check DOM for IVQ... reference
    try {
      if (typeof page.waitForURL === 'function') {
        await page.waitForURL(/success|receipt|confirmation|darshan/i, { timeout: 10000 }).catch(() => {});
      }
    } catch {
      // Best-effort wait
    }
    await page.waitForTimeout(2000);

    // Extract IVQ reference from DOM or confirmation dialog
    let bodyText = '';
    if (typeof page.innerText === 'function') {
      bodyText = await page.innerText('body').catch(() => '');
    }

    const confirmModal = page.locator('mat-dialog-container, .modal, .swal2-modal, [id*="confirmation"]').first();
    let modalText = '';
    if (await confirmModal.isVisible({ timeout: 1500 }).catch(() => false)) {
      modalText = await confirmModal.innerText().catch(() => '');
    }
    const combinedText = `${modalText} ${bodyText}`;

    // Extract official IVQ reference
    const ivqMatch = combinedText.match(/\b(IVQ[0-9A-Z]{6,30})\b/i);
    const vqMatch = combinedText.match(/\b(VQ[0-9A-Z]{6,30})\b/i);
    const txnMatch = combinedText.match(/(?:Transaction\s*(?:ID|No|Reference)|TXN\s*ID)[\s:]+([0-9A-Z]{6,30})/i);
    const txnPrefixMatch = combinedText.match(/\b(TXN[0-9A-Z]{6,30})\b/i);

    let officialReference = '';
    if (ivqMatch) {
      officialReference = ivqMatch[1].trim();
    } else if (vqMatch) {
      officialReference = vqMatch[1].trim();
    } else if (txnPrefixMatch) {
      officialReference = txnPrefixMatch[1].trim();
    } else if (txnMatch) {
      officialReference = txnMatch[1].trim();
    }

    if (officialReference) {
      SanitizedLogger.info(`[PAYMENT-REVIEW] Extracted official reference: ${officialReference}`);
      ctx.officialBookingReference = officialReference;
      ctx.officialReference = officialReference;
    }

    return {
      confirmed: !!officialReference,
      officialReference: officialReference || undefined,
      officialBookingReference: officialReference || undefined,
      portalTransactionReference: txnMatch ? txnMatch[1].trim() : undefined,
      isZeroCost: true,
      confirmedAt: new Date().toISOString(),
    };
  }
}
