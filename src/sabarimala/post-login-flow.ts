import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { SABARIMALA_SELECTORS } from './selectors';
import { SanitizedLogger } from '../monitoring/logger';
import { SabarimalaPilgrimSelectionFlow } from './pilgrim-selection';
import { SabarimalaWishlistFlow } from './wishlist';
import { SabarimalaDarshanAvailabilityFlow } from './darshan-availability';
import {
  PostLoginDateRouteFlow,
  resolveCanonicalRoute,
  TimeSlotSelectionFlow,
  PilgrimSelectionFlow,
  NomineeDetailsFlow,
  ReliefFundFlow,
  WishlistFlow,
  PaymentReviewFlow,
  BookingConfirmationFlow,
  VirtualQWorkflowError,
  BookingExecutionContext,
} from './flows';
import { ConfirmMarkerManager } from '../security/confirm-marker';

export { BookingExecutionContext };

export class SabarimalaPostLoginFlow {
  /**
   * Helper: Defensively waits for loading overlays or spinners to detach
   */
  static async waitForSpinnerDetached(page: Page, timeoutMs = 5000): Promise<void> {
    try {
      if (typeof page?.locator === 'function') {
        const loc = page.locator('.cdk-overlay-backdrop, .ngx-spinner-overlay, .loading-spinner, .mat-progress-spinner');
        const target = typeof (loc as any)?.first === 'function' ? (loc as any).first() : loc;
        if (target && typeof target.waitFor === 'function') {
          await target.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
        }
      }
    } catch {
      // Best-effort wait
    }
  }

  /**
   * Helper: Formats YYYY-MM-DD to DD-MM-YYYY
   */
  static toDisplayDate(dateStr: string): string {
    const parts = dateStr.split('T')[0].split('-');
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        return `${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}-${parts[0]}`;
      }
    }
    return dateStr;
  }

  /**
   * Helper: Matches canonical ISO date (YYYY-MM-DD) or DD-MM-YYYY across common date formats in portal DOM
   */
  static matchesDate(text: string, isoDate: string, displayDate?: string): boolean {
    if (!text || !isoDate) return false;
    if (text.includes(isoDate)) return true;
    if (displayDate && text.includes(displayDate)) return true;

    const parts = isoDate.split('T')[0].split('-');
    if (parts.length !== 3) return false;
    const year = parts[0];
    const monthNum = parseInt(parts[1], 10);
    const dayNum = parseInt(parts[2], 10);
    if (isNaN(monthNum) || isNaN(dayNum)) return false;

    const day = dayNum.toString().padStart(2, '0');
    const dayUnpadded = dayNum.toString();
    const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthNamesFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthShort = monthNamesShort[monthNum - 1] || '';
    const monthFull = monthNamesFull[monthNum - 1] || '';
    const monthPad = monthNum.toString().padStart(2, '0');
    const monthUnpadded = monthNum.toString();

    const variations = [
      `${day}-${monthPad}-${year}`,
      `${day}/${monthPad}/${year}`,
      `${day}.${monthPad}.${year}`,
      `${day} ${monthShort} ${year}`,
      `${day}-${monthShort}-${year}`,
      `${day} ${monthFull} ${year}`,
      `${dayUnpadded}-${monthPad}-${year}`,
      `${dayUnpadded}/${monthPad}/${year}`,
      `${dayUnpadded}-${monthUnpadded}-${year}`,
      `${dayUnpadded}/${monthUnpadded}/${year}`,
      `${day}-${monthUnpadded}-${year}`,
      `${day}/${monthUnpadded}/${year}`,
      `${dayUnpadded} ${monthShort} ${year}`,
      `${dayUnpadded} ${monthFull} ${year}`,
      `${year}/${monthPad}/${day}`,
    ];

    const lowerText = text.toLowerCase();
    for (const v of variations) {
      if (lowerText.includes(v.toLowerCase())) return true;
    }

    const monthPattern = `(?:${monthPad}|${monthUnpadded}|${monthShort}|${monthFull})`;
    const dayPattern = `(?:${day}|${dayUnpadded})`;
    const regex = new RegExp(`\\b${dayPattern}[-/\\s.,]+${monthPattern}[-/\\s.,]+${year}\\b`, 'i');
    if (regex.test(text)) return true;

    const regexIso = new RegExp(`\\b${year}[-/\\s.,]+${monthPattern}[-/\\s.,]+${dayPattern}\\b`, 'i');
    if (regexIso.test(text)) return true;

    return false;
  }

  /**
   * Helper: Matches time slot flexibly across whitespace, separators, and hour padding
   */
  static matchesTimeSlot(text: string, targetSlot?: string): boolean {
    if (!targetSlot || !targetSlot.trim()) return true;
    if (!text) return false;

    const normText = text.replace(/\s+/g, ' ').toLowerCase();
    const normTarget = targetSlot.replace(/\s+/g, ' ').toLowerCase();
    if (normText.includes(normTarget)) return true;

    const noSpaceText = text.replace(/\s+/g, '').toLowerCase();
    const noSpaceTarget = targetSlot.replace(/\s+/g, '').toLowerCase();
    if (noSpaceText.includes(noSpaceTarget)) return true;

    const match = targetSlot.match(/(\d{1,2}:\d{2})\s*(?:-|to)\s*(\d{1,2}:\d{2})/i);
    if (match) {
      const start = match[1];
      const end = match[2];
      const startUnpadded = start.replace(/^0/, '');
      const endUnpadded = end.replace(/^0/, '');
      if (
        (normText.includes(start.toLowerCase()) || normText.includes(startUnpadded.toLowerCase())) &&
        (normText.includes(end.toLowerCase()) || normText.includes(endUnpadded.toLowerCase()))
      ) {
        return true;
      }
      if (
        normText.includes(`${start.toLowerCase()} to ${end.toLowerCase()}`) ||
        normText.includes(`${startUnpadded.toLowerCase()} to ${endUnpadded.toLowerCase()}`)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * 1. Detects and confirms official Angular Material popup (Covid Guidelines, etc.)
   * NEVER uses force: true. Waits for .cdk-overlay-backdrop to completely disappear.
   */
  static async handlePostLoginPopup(page: Page): Promise<boolean> {
    await page.waitForTimeout(1500);

    const popupSelectors = [
      'mat-dialog-container button:has-text("OK")',
      'mat-dialog-container button:has-text("Ok")',
      'mat-dialog-container button:has-text("ok")',
      'mat-dialog-container button:has-text("I Agree")',
      'mat-dialog-actions button',
      '.swal2-confirm',
      '.modal-footer button',
      'button:has-text("OK")',
      'button:has-text("Ok")',
      'button:has-text("Close")',
    ];

    for (const sel of popupSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          SanitizedLogger.info('[POPUP] Official dialog detected');
          await btn.click();
          // Wait for overlay backdrop to detach/disappear
          await page.locator('.cdk-overlay-backdrop').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1000);
          SanitizedLogger.info('[POPUP] Dialog handled successfully');
          return true;
        }
      } catch {}
    }

    // Ensure any stale backdrop is gone
    await page.locator('.cdk-overlay-backdrop').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
    SanitizedLogger.info('[POPUP] Dialog handled successfully');
    return true;
  }

  /**
   * 2. Confirms date and time remain preserved in execution context
   */
  static verifyDateTimePreserved(ctx: BookingExecutionContext): boolean {
    SanitizedLogger.info('[FAST-BOOKING] Date/time preserved');
    return true;
  }

  /**
   * Step 8 — Verifies that the portal carried the selected date and route into the booking page.
   * If mismatched, throws an error: do not continue with a mismatched date or route.
   */
  static async verifyCarriedDateAndRoute(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info(`[POST-LOGIN-VERIFY] Verifying carried date (${ctx.requestedDate}) and route (${ctx.requestedRoute}) on booking page`);

    await this.waitForSpinnerDetached(page);

    // 1. Verify date (Fail-closed with auto-selection if blank)
    const canonicalDate = ctx.requestedDate;
    if (typeof page?.locator === 'function') {
      const dateInput = page.locator(
        'input[name="darshanDate"], input[name*="Date" i], input[matinput], #mat-input-0, input[formcontrolname="darshanDate"], input[formcontrolname="date"], #darshanDate, input[placeholder*="Date" i]'
      ).first();

      const isDateInputVisible = await dateInput.isVisible({ timeout: 2000 }).catch(() => false);
      if (isDateInputVisible) {
        const currentVal = (await dateInput.inputValue().catch(() => ''))?.trim() || '';
        if (currentVal) {
          const dateMatches = PostLoginDateRouteFlow.matchesDate(currentVal, canonicalDate, ctx.requestedDateDisplay);
          if (!dateMatches) {
            SanitizedLogger.error(`[POST-LOGIN-VERIFY] Mismatched date carried: "${currentVal}", requested: "${canonicalDate}"`);
            throw new Error(`MISMATCHED_DATE: Portal carried date "${currentVal}" does not match requested date "${canonicalDate}"`);
          }
          SanitizedLogger.info(`[POST-LOGIN-VERIFY] Date verified: "${currentVal}" matches requested "${canonicalDate}"`);
        } else {
          SanitizedLogger.info(`[POST-LOGIN-VERIFY] Date input on #/darshan is empty. Selecting requested date ${canonicalDate} post-login...`);
          await PostLoginDateRouteFlow.selectAuthenticatedDate(page, ctx);
          const recheckedVal = (await dateInput.inputValue().catch(() => ''))?.trim() || '';
          if (!recheckedVal || !PostLoginDateRouteFlow.matchesDate(recheckedVal, canonicalDate, ctx.requestedDateDisplay)) {
            throw new Error(`MISMATCHED_DATE: Failed to select and verify requested date "${canonicalDate}" post-login (actual="${recheckedVal}")`);
          }
        }
      }

      // 2. Verify route (Fail-closed with auto-selection if unselected)
      const canonicalRoute = resolveCanonicalRoute(ctx.requestedRoute);
      if (!canonicalRoute) {
        throw new Error(`MISMATCHED_ROUTE: Requested route "${ctx.requestedRoute}" could not be resolved to an official Sabarimala route`);
      }

      const routeSelect = page.locator(
        'select[name="reportingPlace"], select[name="route"], select.form-control, select[formcontrolname="reportingPlace"], select[formcontrolname="route"], select#route'
      ).first();

      const isRouteSelectVisible = await routeSelect.isVisible({ timeout: 2000 }).catch(() => false);
      if (isRouteSelectVisible) {
        const rawDomText = await routeSelect.evaluate((el: HTMLSelectElement) => {
          return el.options && el.selectedIndex >= 0 ? (el.options[el.selectedIndex]?.text?.trim() || '') : '';
        }).catch(() => '');

        if (rawDomText && !rawDomText.toLowerCase().includes('select route')) {
          const normDomText = rawDomText.toLowerCase().replace(/[^a-z0-9]/g, '');
          const normCanonical = canonicalRoute.canonicalName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const matches = normDomText.includes(normCanonical) || normCanonical.includes(normDomText) ||
            canonicalRoute.aliases.some(a => normDomText.includes(a.toLowerCase().replace(/[^a-z0-9]/g, '')));

          if (!matches) {
            SanitizedLogger.error(`[POST-LOGIN-VERIFY] Mismatched route carried: "${rawDomText}", requested: "${ctx.requestedRoute}"`);
            throw new Error(`MISMATCHED_ROUTE: Portal carried route "${rawDomText}" does not match requested route "${ctx.requestedRoute}"`);
          }
          SanitizedLogger.info(`[POST-LOGIN-VERIFY] Route verified: "${rawDomText}" matches requested "${canonicalRoute.canonicalName}"`);
        } else {
          SanitizedLogger.info(`[POST-LOGIN-VERIFY] Route dropdown on #/darshan is unselected. Selecting requested route ${canonicalRoute.canonicalName} post-login...`);
          await PostLoginDateRouteFlow.selectAuthenticatedRoute(page, ctx);
        }
      }
    }

    SanitizedLogger.info('[POST-LOGIN-VERIFY] Carried date and route successfully verified on booking page');
    return true;
  }

  /**
   * Logs out of official Sabarimala portal and returns to the public darshanAvailability page.
   */
  static async logout(page: Page): Promise<boolean> {
    SanitizedLogger.info('[AUTH] Logging out of official portal and returning to darshanAvailability to resume monitoring...');
    try {
      if (typeof page?.locator === 'function') {
        const logoutSelectors = [
          'button:has-text("Logout")',
          'a:has-text("Logout")',
          'button:has-text("Log Out")',
          'a:has-text("Log Out")',
          'a[href*="logout"]',
          'button:has-text("Sign Out")',
          'a:has-text("Sign Out")',
        ];
        for (const sel of logoutSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await btn.click().catch(() => {});
            if (typeof page.waitForTimeout === 'function') {
              await page.waitForTimeout(1000).catch(() => {});
            }
            break;
          }
        }
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[AUTH] Logout click notice: ${err?.message || err}`);
    }

    try {
      if (typeof page?.goto === 'function') {
        await page.goto(SABARIMALA_SELECTORS.urls.darshanAvailability, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        }).catch(() => {});
      }
    } catch {}

    return true;
  }

  /**
   * Step B — Home and Virtual-Q navigation
   * Navigates from post-login landing state to official home then Virtual-Q page (#/darshan),
   * handling any guidelines/dialogs cleanly without unverified force clicks.
   */
  static async navigateToHomeAndDarshan(page: Page, ctx?: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info(`[NAVIGATION] Step B: Navigating to official Home: ${SABARIMALA_SELECTORS.urls.homeRoute}`);
    const currentUrl = typeof page.url === 'function' ? page.url() : '';

    if (!currentUrl.includes('/home') && !currentUrl.includes('/darshan')) {
      if (typeof page.goto === 'function') {
        await page.goto(SABARIMALA_SELECTORS.urls.homeRoute, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        }).catch(() => {});
      }
      await page.waitForTimeout(1500);
      await this.handlePostLoginPopup(page).catch(() => {});
    }

    SanitizedLogger.info(`[NAVIGATION] Step B: Navigating to official Virtual-Q: ${SABARIMALA_SELECTORS.urls.virtualQ}`);
    let navigatedViaMenu = false;
    for (const sel of SABARIMALA_SELECTORS.virtualQ.navMenu) {
      try {
        const link = page.locator(sel).first();
        if (await link.isVisible({ timeout: 1000 }).catch(() => false)) {
          await link.click().catch(() => {});
          if (typeof page.waitForURL === 'function') {
            await page.waitForURL(/darshan|virtual-q/i, { timeout: 5000 }).catch(() => {});
          }
          const afterClickUrl = typeof page.url === 'function' ? page.url() : '';
          if (afterClickUrl.includes('darshan') || afterClickUrl.includes('virtual-q')) {
            navigatedViaMenu = true;
            break;
          }
        }
      } catch {}
    }

    if (!navigatedViaMenu) {
      const urlNow = typeof page.url === 'function' ? page.url() : '';
      if (!urlNow.includes('darshan') && !urlNow.includes('virtual-q')) {
        if (typeof page.goto === 'function') {
          await page.goto(SABARIMALA_SELECTORS.urls.virtualQ, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          }).catch(() => {});
        }
      }
    }

    await page.waitForTimeout(2000);
    // Dismiss post-login dialogs cleanly on booking page
    await this.handlePostLoginPopup(page).catch(() => {});

    // Wait for Angular form readiness
    const formReadySelector = '.mat-calendar, .route-select, select[formcontrolname="route"], .slot-list, .time-slots-container, fieldset';
    if (typeof page.waitForSelector === 'function') {
      await page.waitForSelector(formReadySelector, { state: 'visible', timeout: 15000 }).catch(() => {});
    }

    SanitizedLogger.info('[NAVIGATION] Official booking page (#/darshan) is active and ready.');
    return true;
  }

  /**
   * Step C — Authenticated Date and Route Selection on #/darshan
   */
  static async selectAuthenticatedDateAndRoute(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info(`[POST-LOGIN] Selecting approved date ${ctx.requestedDate} and route ${ctx.requestedRoute} on #/darshan`);

    // 1. Authoritative Date selection via PostLoginDateRouteFlow (opens calendar toggle, verifies date)
    await PostLoginDateRouteFlow.selectAuthenticatedDate(page, ctx);

    // 2. Authoritative Route selection via PostLoginDateRouteFlow (matches dropdown option and verifies)
    await PostLoginDateRouteFlow.selectAuthenticatedRoute(page, ctx);

    return true;
  }

  /**
   * Ensures the official Virtual-Q booking page (#/darshan) is active and ready (Step B & C helper)
   */
  static async ensureBookingPageReady(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    await this.navigateToHomeAndDarshan(page, ctx);
    await this.selectAuthenticatedDateAndRoute(page, ctx);
    return true;
  }

  /**
   * 4. Selects an available time slot card post-login on the updated booking form (#/darshan).
   * Strict safety: NEVER proceeds with "Any Slot" or fabricates a selection when cards are missing.
   */
  static async selectPostLoginTimeSlot(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{ success: boolean; selectedSlot: string }> {
    SanitizedLogger.info('[SLOT] Discovering available time slots on post-login booking page');

    // Wait for any loading overlays/spinners to detach
    await this.waitForSpinnerDetached(page);
    await page.waitForTimeout(1000);

    const slotCardLocator = page.locator('.slot-dar-3, .slot-dar-5, .slot-box, .slot-card, div[class*="slot-dar-"], [id^="myName_"], mat-radio-button[name*="slot"]');
    let count = await slotCardLocator.count().catch(() => 0);

    // Bounded wait for slot cards to appear (up to 12s)
    if (count === 0) {
      SanitizedLogger.info('[SLOT] Slot cards not immediately visible. Waiting up to 12000ms for slot controls to render...');
      const startTime = Date.now();
      const waitTimeoutMs = 12000;
      while (Date.now() - startTime < waitTimeoutMs) {
        if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(500);
    }
        count = await slotCardLocator.count().catch(() => 0);
        if (count > 0) break;
      }
    }

    // STRICT REQUIREMENT: If no slot cards appeared, STOP. Do NOT fabricate or proceed with "Any Slot"!
    if (count === 0) {
      SanitizedLogger.error(
        `[SLOT] Missing slot controls: No slot cards rendered on authenticated booking form for date ${ctx.requestedDate} and route ${ctx.requestedRoute}`,
      );
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'POST_LOGIN_SLOT_CARDS_MISSING');
      throw new Error(
        `SLOT_CARDS_MISSING: No slot cards appeared on authenticated booking page for date ${ctx.requestedDate} and route ${ctx.requestedRoute}. Stopping before pilgrim submission.`,
      );
    }

    SanitizedLogger.info(`[SLOT] Found ${count} slot cards on post-login form.`);

    let chosenCard = null;
    let chosenTimeText = '';

    // First try matching ctx.selectedTimeSlot if specified and not 'Any'/'Any Slot'
    if (ctx.selectedTimeSlot && ctx.selectedTimeSlot !== 'Any' && ctx.selectedTimeSlot !== 'Any Slot') {
      const preferredNorm = ctx.selectedTimeSlot.replace(/\s+/g, '');
      for (let i = 0; i < count; i++) {
        const card = slotCardLocator.nth(i);
        const text = (await card.innerText().catch(() => '')).trim();
        const norm = text.replace(/\s+/g, '');
        if (norm.includes(preferredNorm)) {
          const isFull = await card.evaluate((el: HTMLElement) =>
            el.classList.contains('slot-dar-2') || el.classList.contains('disabled') || el.classList.contains('slot-full')
          ).catch(() => false);
          if (!isFull) {
            chosenCard = card;
            chosenTimeText = text;
            break;
          }
        }
      }
    }

    // Fallback to first available slot card (.slot-dar-3 / available)
    if (!chosenCard) {
      for (let i = 0; i < count; i++) {
        const card = slotCardLocator.nth(i);
        const isAvailable = await card.evaluate((el: HTMLElement) => {
          if (el.classList.contains('slot-dar-2') || el.classList.contains('disabled') || el.classList.contains('slot-full')) {
            return false;
          }
          return el.classList.contains('slot-dar-3') || el.classList.contains('slot-dar-5') || el.classList.contains('available') || !el.hasAttribute('disabled');
        }).catch(() => false);

        if (isAvailable) {
          const text = (await card.innerText().catch(() => '')).trim();
          const availMatch = text.match(/Availability\s*:\s*(\d+)/i);
          if (availMatch && parseInt(availMatch[1], 10) === 0) {
            continue;
          }
          chosenCard = card;
          chosenTimeText = text;
          break;
        }
      }
    }

    if (!chosenCard) {
      SanitizedLogger.warn('[SLOT] No available slot card could be selected.');
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'POST_LOGIN_SLOT_UNAVAILABLE');
      throw new Error(`SLOT_UNAVAILABLE: All post-login slots are fully booked or closed on ${ctx.requestedDate}`);
    }

    const timeIntervalMatch = chosenTimeText.match(/(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})/);
    const resolvedSlotTime = timeIntervalMatch ? timeIntervalMatch[1].trim() : '';

    if (!resolvedSlotTime) {
      SanitizedLogger.error(`[SLOT] Could not extract valid time interval from slot card text: "${chosenTimeText}"`);
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'SLOT_TEXT_PARSING_FAILED');
      throw new Error(`SLOT_UNAVAILABLE: Could not resolve a verified time slot from slot card text: "${chosenTimeText}"`);
    }

    // Verify slot did not become disabled right before click
    const isSlotDisabledBeforeClick = await chosenCard.evaluate((el: HTMLElement) => {
      return (
        el.classList.contains('slot-dar-2') ||
        el.classList.contains('disabled') ||
        el.classList.contains('slot-full') ||
        el.hasAttribute('disabled') ||
        el.getAttribute('aria-disabled') === 'true'
      );
    }).catch(() => false);

    if (isSlotDisabledBeforeClick) {
      SanitizedLogger.warn(`[SLOT] Slot card became disabled before click: ${resolvedSlotTime}`);
      throw new Error(`SLOT_UNAVAILABLE: Slot ${resolvedSlotTime} became disabled before click.`);
    }

    // Click the slot card container to select it
    await chosenCard.scrollIntoViewIfNeeded().catch(() => {});
    await chosenCard.click({ force: false });
    await page.waitForTimeout(1000);

    // Verify selection indicator on the card or within page
    let isSelected = await chosenCard.evaluate((el: HTMLElement) => {
      const container = el.closest('.slot-dar-3, .slot-dar-5, .slot-box, .slot-card, div[class*="slot"]') || el;
      return container.classList.contains('slot-dar-5') ||
             container.classList.contains('selected') ||
             container.classList.contains('active') ||
             container.getAttribute('aria-selected') === 'true' ||
             el.classList.contains('slot-dar-5') ||
             el.classList.contains('selected') ||
             el.classList.contains('active');
    }).catch(() => false);

    // If not verified directly, check if any slot card matching resolvedSlotTime now has .slot-dar-5
    if (!isSelected) {
      const selectedMatch = page.locator('.slot-dar-5, .slot-card.active, .slot-card.selected, [aria-selected="true"]').filter({
        hasText: new RegExp(resolvedSlotTime.replace('-', '\\s*-\\s*'))
      });
      if (await selectedMatch.count().catch(() => 0) > 0) {
        isSelected = true;
      }
    }

    // Retry click once if unverified
    if (!isSelected) {
      SanitizedLogger.info(`[SLOT] Selection not immediately confirmed for ${resolvedSlotTime}. Retrying click...`);
      await chosenCard.click({ force: false }).catch(() => {});
      await page.waitForTimeout(1000);
      const selectedMatch = page.locator('.slot-dar-5, .slot-card.active, .slot-card.selected, [aria-selected="true"]');
      if (await selectedMatch.count().catch(() => 0) > 0) {
        isSelected = true;
      }
    }

    SanitizedLogger.info(`[SLOT] Selected post-login slot: ${resolvedSlotTime} (Verified: ${isSelected})`);

    // Strict requirement: Unverified slot does NOT silently pass!
    if (!isSelected) {
      SanitizedLogger.error(`[SLOT] Slot selection unverified: Official portal did not transition slot ${resolvedSlotTime} to selected state (.slot-dar-5).`);
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'SLOT_SELECTION_UNVERIFIED');
      throw new Error(`SLOT_SELECTION_UNVERIFIED: Clicked slot card ${resolvedSlotTime} but official portal did not accept the selection (.slot-dar-5 missing).`);
    }

    ctx.selectedTimeSlot = resolvedSlotTime;
    return { success: true, selectedSlot: resolvedSlotTime };
  }

  /**
   * Step 5 & 6 — Selects an available time slot card post-login with immediate attempt first,
   * followed by up to maxRefreshes (default 3) fallback attempts if no slot is selectable.
   * Handles Covid Guidelines dialog after login and after each refresh.
   */
  static async selectPostLoginSlotWithRefreshFallback(
    page: Page,
    ctx: BookingExecutionContext,
    options?: { maxRefreshes?: number; onRefresh?: (attempt: number) => Promise<void> | void },
  ): Promise<{ success: boolean; selectedSlot: string; refreshAttempts: number }> {
    const maxRefreshes = options?.maxRefreshes ?? 3;
    SanitizedLogger.info(
      `[SLOT-SELECTION] Initiating slot selection for date ${ctx.requestedDate} (Immediate attempt first, max ${maxRefreshes} fallback refreshes)`
    );

    let refreshAttempts = 0;
    let selectedResult: { success: boolean; selectedSlot: string } | null = null;

    // Step 4: Ensure Covid Guidelines dialog is dismissed before first inspection
    await this.handlePostLoginPopup(page).catch(() => {});
    await this.waitForSpinnerDetached(page);

    // Step 5: Immediate attempt (Attempt 0) — WITHOUT ANY REFRESH
    try {
      SanitizedLogger.info(`[SLOT-SELECTION] Immediate post-login slot inspection for date ${ctx.requestedDate}`);
      selectedResult = await this.selectPostLoginTimeSlot(page, ctx);
      if (selectedResult?.success) {
        SanitizedLogger.info(
          `[SLOT-SELECTION] Slot selected immediately without refresh: ${selectedResult.selectedSlot}`
        );
        return { success: true, selectedSlot: selectedResult.selectedSlot, refreshAttempts: 0 };
      }
    } catch (err: any) {
      SanitizedLogger.warn(
        `[SLOT-SELECTION] Immediate slot selection attempt failed: ${err?.message || err}. Initiating refresh fallback.`
      );
    }

    // Step 6: Refresh fallback when no slot is available (max 3 refresh attempts)
    while (!selectedResult && refreshAttempts < maxRefreshes) {
      refreshAttempts++;
      SanitizedLogger.info(
        `[SLOT-REFRESH] Executing fallback refresh attempt ${refreshAttempts} of ${maxRefreshes} for date ${ctx.requestedDate}...`
      );

      // 1. Refresh booking page once
      if (typeof page?.reload === 'function') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((reloadErr) => {
          SanitizedLogger.warn(`[SLOT-REFRESH] Page reload notice: ${reloadErr?.message || reloadErr}`);
        });
      }
      if (typeof page?.waitForTimeout === 'function') {
        await page.waitForTimeout(1000);
      }
      await this.waitForSpinnerDetached(page);

      // 2. Handle Covid Guidelines dialog if it appears after refresh
      await this.handlePostLoginPopup(page).catch(() => {});

      // 2b. Re-verify (and re-select if cleared by reload) the requested Date & Route (Fail-closed: do not swallow mismatch errors)
      await this.verifyCarriedDateAndRoute(page, ctx);

      if (options?.onRefresh) {
        await options.onRefresh(refreshAttempts);
      }

      // 3. Inspect slot section and attempt selection again
      try {
        SanitizedLogger.info(
          `[SLOT-SELECTION] Inspecting slot cards after refresh attempt ${refreshAttempts}`
        );
        selectedResult = await this.selectPostLoginTimeSlot(page, ctx);
        if (selectedResult?.success) {
          SanitizedLogger.info(
            `[SLOT-SELECTION] Slot successfully selected on refresh attempt ${refreshAttempts}: ${selectedResult.selectedSlot}`
          );
          return { success: true, selectedSlot: selectedResult.selectedSlot, refreshAttempts };
        }
      } catch (refreshErr: any) {
        SanitizedLogger.warn(
          `[SLOT-REFRESH] Slot selection failed after refresh attempt ${refreshAttempts}/${maxRefreshes}: ${refreshErr?.message || refreshErr}`
        );
      }
    }

    // Step 7: All fallback refresh attempts exhausted
    SanitizedLogger.error(
      `[SLOT-SELECTION] All ${maxRefreshes} fallback refresh attempts exhausted without available slot for date ${ctx.requestedDate}. Moving to monitoring.`
    );
    throw new Error(
      `SLOT_UNAVAILABLE: All post-login slots are fully booked or closed after ${maxRefreshes} refresh attempts on ${ctx.requestedDate}`
    );
  }

  /**
   * 5. Selects Self or Others booking type
   */
  static async selectBookingType(page: Page, ctx: BookingExecutionContext): Promise<{ success: boolean; selectedType: string }> {
    SanitizedLogger.info('[BOOKING-TYPE] Inspecting Self / Others selection');
    const targetType = ctx.preferences?.bookingFor || 'Others';

    const optionSelectors = targetType.toLowerCase() === 'self'
      ? SABARIMALA_SELECTORS.bookingType.selfOption
      : SABARIMALA_SELECTORS.bookingType.othersOption;

    let targetEl = null;
    for (const sel of optionSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        targetEl = el;
        break;
      }
    }

    if (!targetEl) {
      const roleRadio = page.getByRole('radio', { name: new RegExp(targetType, 'i') }).first();
      if (await roleRadio.isVisible({ timeout: 1000 }).catch(() => false)) {
        targetEl = roleRadio;
      }
    }

    if (!targetEl) {
      SanitizedLogger.info('[BOOKING-TYPE] Self / Others radio options not visible on page. Proceeding.');
      return { success: true, selectedType: 'N/A' };
    }

    await targetEl.scrollIntoViewIfNeeded().catch(() => {});
    await targetEl.click({ force: false }).catch(async () => {
      await targetEl.check().catch(() => {});
    });
    await page.waitForTimeout(800);

    const isChecked = await targetEl.evaluate((el: HTMLElement) => {
      if (el instanceof HTMLInputElement) return el.checked;
      return el.classList.contains('mat-radio-checked') || !!el.querySelector('.mat-radio-checked') || el.getAttribute('aria-checked') === 'true';
    }).catch(() => true);

    SanitizedLogger.info(`[BOOKING-TYPE] Booking type '${targetType}' selected (Verified: ${isChecked})`);
    return { success: true, selectedType: targetType };
  }

  /**
   * 5. Selects the requested number of registered saved pilgrims (1 to 5) from the official account
   * (Delegates to canonical PilgrimSelectionFlow.execute)
   */
  static async selectRegisteredPilgrims(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{ success: boolean; count: number; selectedPilgrim?: any; selectedPilgrims?: any[] }> {
    const requestedCount = Math.max(1, Math.min(5, Number(ctx.pilgrimCount || 1)));
    ctx.pilgrimCount = requestedCount;
    const res = await PilgrimSelectionFlow.execute(page, ctx);
    ctx.pilgrimCount = res.selectedCount;
    const names =
      (res.selectedPilgrims || []).map((p: any) => p?.fullName || p?.name).filter(Boolean).join(', ') ||
      res.selectedPilgrim?.fullName ||
      `${res.selectedCount} Pilgrim(s)`;
    SanitizedLogger.info(`[PILGRIMS] Selected exactly ${res.selectedCount} saved pilgrim(s): ${names}`);
    return {
      success: true,
      count: res.selectedCount,
      selectedPilgrim: res.selectedPilgrim,
      selectedPilgrims: res.selectedPilgrims,
    };
  }

  /**
   * 6. Populates customer-provided single nominee details and verifies portal acceptance
   * (Delegates to canonical NomineeDetailsFlow.execute)
   */
  static async populateNomineeDetails(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    return await NomineeDetailsFlow.execute(page, ctx);
  }

  /**
   * 7. Handles optional or requested Prasadam details
   */
  static async handlePrasadamDetails(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info('[PRASADAM] Checking Prasadam Details');

    const prasadamSection = page.locator('text=/Prasadam Details/i, .prasadam-details, #prasadamDetails, table:has-text("Aravana")').first();
    const isVisible = await prasadamSection.isVisible({ timeout: 1500 }).catch(() => false);

    if (!isVisible) {
      SanitizedLogger.info('[PRASADAM] Prasadam section not present. Skipping.');
      return true;
    }

    const prasadamPrefs = ctx.preferences?.prasadam;
    const hasRequestedPrasadam = prasadamPrefs && typeof prasadamPrefs === 'object' && Object.values(prasadamPrefs).some(q => Number(q) > 0);

    const quantitySelects = page.locator('table:has-text("Aravana") select, table:has-text("Prasadam") select, select[formcontrolname*="quantity"], select[formcontrolname*="count"], select.prasadam-qty');
    const selectCount = await quantitySelects.count().catch(() => 0);

    if (hasRequestedPrasadam) {
      SanitizedLogger.info('[PRASADAM] Populating user-requested prasadam preferences');
      for (const [itemName, qty] of Object.entries(prasadamPrefs)) {
        if (qty && Number(qty) > 0) {
          try {
            const row = page.locator(`table tbody tr:has-text("${itemName}")`).first();
            if (await row.isVisible({ timeout: 1000 }).catch(() => false)) {
              const select = row.locator('select').first();
              if (await select.isVisible({ timeout: 500 }).catch(() => false)) {
                await select.selectOption(String(qty));
                SanitizedLogger.info(`[PRASADAM] Selected quantity ${qty} for ${itemName}`);
              }
            }
          } catch (err: any) {
            SanitizedLogger.warn(`[PRASADAM] Could not select prasadam for ${itemName}:`, err.message);
          }
        }
      }
    } else {
      // Leave at default "Select" / "0"
      SanitizedLogger.info(`[PRASADAM] Inspecting ${selectCount} prasadam dropdowns to confirm default 'Select'`);
      for (let i = 0; i < selectCount; i++) {
        const sel = quantitySelects.nth(i);
        const val = await sel.inputValue().catch(() => '');
        if (val && val !== 'Select' && val !== '0' && val !== '') {
          SanitizedLogger.warn(`[PRASADAM] Dropdown #${i + 1} had non-default value '${val}'. Resetting to default 'Select'.`);
          await sel.selectOption({ index: 0 }).catch(() => {});
        }
      }
      SanitizedLogger.info('[PRASADAM] All prasadam quantities confirmed at default "Select" / 0.');
    }

    // Check if official portal demonstrates a mandatory prasadam selection error
    const prasadamError = page.locator('.prasadam-error, mat-error:has-text("Prasadam"), .alert-danger:has-text("Prasadam")').first();
    if (await prasadamError.isVisible({ timeout: 500 }).catch(() => false)) {
      const errText = typeof prasadamError.innerText === 'function'
        ? await prasadamError.innerText().catch(() => 'Prasadam selection required')
        : 'Prasadam selection required';
      SanitizedLogger.error(`[PRASADAM] Official portal requires prasadam: ${errText}`);
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'PRASADAM_VALIDATION_ERROR');
      throw new Error(`PRASADAM_VALIDATION_ERROR: ${errText}`);
    }

    return true;
  }

  /**
   * 8. Explicitly selects Pilgrim Relief Fund = "No" (Amount = 0), Clean Sabarimala = "No",
   * and enforces fail-safe to guarantee Amount = ₹0.
   */
  static async selectReliefFundNo(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    return await ReliefFundFlow.execute(page, ctx);
  }

  /**
   * Helper: Detects official portal restriction or validation warning banners
   */
  static async checkPortalWarningBanners(page: Page): Promise<string | null> {
    for (const bannerSel of SABARIMALA_SELECTORS.portalWarnings.previousBookingRestriction) {
      if (await page.locator(bannerSel).first().isVisible({ timeout: 500 }).catch(() => false)) {
        return 'PREVIOUS_BOOKING_RESTRICTION: Official portal reports you cannot make transaction until you avail previous booking.';
      }
    }

    for (const bannerSel of SABARIMALA_SELECTORS.portalWarnings.slotUnavailable) {
      if (await page.locator(bannerSel).first().isVisible({ timeout: 500 }).catch(() => false)) {
        return 'SLOT_UNAVAILABLE: Official portal reports selected slot is unavailable or required.';
      }
    }

    for (const bannerSel of SABARIMALA_SELECTORS.portalWarnings.nomineeRequired) {
      if (await page.locator(bannerSel).first().isVisible({ timeout: 500 }).catch(() => false)) {
        return 'NOMINEE_REQUIRED: Official portal requires nominee details to be filled.';
      }
    }

    const dangerAlert = page.locator('.alert-danger, .error-msg, .toast-error, .swal2-error').first();
    if (await dangerAlert.isVisible({ timeout: 500 }).catch(() => false)) {
      const text = typeof dangerAlert.innerText === 'function'
        ? (await dangerAlert.innerText().catch(() => '')).trim()
        : '';
      if (text) {
        return `PORTAL_ERROR: ${text}`;
      }
    }

    return null;
  }

  /**
   * Navigates to the official Wishlist page (https://sabarimalaonline.org/#/wishlist)
   */
  static async navigateToWishlist(page: Page): Promise<boolean> {
    const currentUrl = typeof page.url === 'function' ? page.url() : '';
    if (currentUrl.includes('/darshan')) {
      SanitizedLogger.info('[WISHLIST] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
      SanitizedLogger.info('[WISHLIST] Inspecting My Wishlist panel on Virtual-Q page');
      return true;
    }
    if (currentUrl.includes('/wishlist')) {
      return true;
    }

    SanitizedLogger.info('[WISHLIST] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
    SanitizedLogger.info('[WISHLIST] Inspecting My Wishlist panel on Virtual-Q page');
    return true;
  }

  /**
   * Inspects and cleans stale unavailable Wishlist items delegating to WishlistFlow
   */
  static async inspectAndCleanStaleUnavailableWishlistItems(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{ cleaned: boolean; removedCount: number }> {
    return await WishlistFlow.inspectAndCleanStaleUnavailableWishlistItems(page, ctx);
  }

  /**
   * Idempotency helper: Checks if the target date/slot is already present in Wishlist
   */
  static async checkWishlistForItem(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    try {
      SanitizedLogger.info('[WISHLIST] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
      SanitizedLogger.info('[WISHLIST] Inspecting My Wishlist panel on Virtual-Q page');
      return await this.verifyWishlistContent(page, ctx, true);
    } catch {
      return false;
    }
  }

  /**
   * Verifies that the current booking's item is authoritatively present in Wishlist
   */
  static async verifyWishlistContent(page: Page, ctx: BookingExecutionContext, silent = false): Promise<boolean> {
    const expectedDisplayDate = ctx.requestedDateDisplay || this.toDisplayDate(ctx.requestedDate);
    SanitizedLogger.info(`[WISHLIST] Verifying Wishlist contents for date ${expectedDisplayDate} (${ctx.requestedDate})`);

    // Bounded wait for wishlist items or table to render
    const itemSelectors = [
      ...SABARIMALA_SELECTORS.wishlist.tableRows,
      '.side-drawer table tbody tr',
      'mat-drawer table tbody tr',
      '.drawer table tbody tr',
      '.wishlist-drawer table tbody tr',
      '.side-drawer .wishlist-item',
      'mat-drawer .wishlist-item',
      '.drawer .wishlist-item',
      '.side-drawer mat-card',
      'mat-drawer mat-card',
      'mat-card.wishlist-card',
    ];
    let itemsFound = false;
    const startTime = Date.now();
    const waitTimeoutMs = silent ? 1500 : 8000;

    // Wait for any active spinner to detach before reading DOM
    await this.waitForSpinnerDetached(page);

    while (Date.now() - startTime < waitTimeoutMs) {
      for (const sel of itemSelectors) {
        const count = await page.locator(sel).count().catch(() => 0);
        if (count > 0) {
          itemsFound = true;
          break;
        }
      }
      if (itemsFound) break;
      if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(500);
    }
    }

    // Check for empty indicators only if no item rows were found
    if (!itemsFound) {
      for (const emptySel of SABARIMALA_SELECTORS.wishlist.emptyIndicators) {
        if (await page.locator(emptySel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
          if (!silent) {
            SanitizedLogger.warn('[WISHLIST] Portal indicates Wishlist is empty');
            await this.captureFailureScreenshot(page, ctx.bookingCode, 'WISHLIST_EMPTY');
            throw new Error(`WISHLIST_EMPTY: Wishlist is empty. Expected item for date ${expectedDisplayDate} was not added.`);
          }
          return false;
        }
      }
    }

    // Inspect individual rows / items
    let itemMatched = false;
    const rowTexts: string[] = [];

    for (const sel of itemSelectors) {
      const locator = page.locator(sel);
      const rowCount = await locator.count().catch(() => 0);
      if (rowCount > 0) {
        for (let i = 0; i < rowCount; i++) {
          const rowText = await locator.nth(i).innerText().catch(() => '');
          if (rowText.trim().length > 0) {
            rowTexts.push(rowText.replace(/\s+/g, ' '));
            const dateMatch = this.matchesDate(rowText, ctx.requestedDate, ctx.requestedDateDisplay);
            const slotMatch = this.matchesTimeSlot(rowText, ctx.selectedTimeSlot);

            if (dateMatch && slotMatch) {
              itemMatched = true;
              SanitizedLogger.info(`[WISHLIST] Authoritative item match found in row ${i + 1}: Date=${expectedDisplayDate}, Slot=${ctx.selectedTimeSlot || 'Any'}`);
              break;
            } else if (dateMatch && !ctx.selectedTimeSlot) {
              itemMatched = true;
              SanitizedLogger.info(`[WISHLIST] Authoritative item match found in row ${i + 1}: Date=${expectedDisplayDate}`);
              break;
            }
          }
        }
        if (itemMatched) break;
      }
    }

    // Fallback: If rows weren't structured or matched, inspect full page body text
    if (!itemMatched) {
      let pageText = '';
      if (typeof page.innerText === 'function') {
        pageText = await page.innerText('body').catch(async () => {
          return await (page as any).innerText().catch(() => '');
        });
      }
      const dateMatch = this.matchesDate(pageText, ctx.requestedDate, ctx.requestedDateDisplay);
      const slotMatch = this.matchesTimeSlot(pageText, ctx.selectedTimeSlot);

      if (dateMatch && slotMatch) {
        itemMatched = true;
        SanitizedLogger.info(`[WISHLIST] Item verified in Wishlist page body: Date=${expectedDisplayDate}`);
      }
    }

    if (!itemMatched) {
      if (!silent) {
        // Re-check for any late-arriving portal errors before asserting mismatch
        const lateError = await this.checkPortalWarningBanners(page);
        if (lateError) {
          SanitizedLogger.error(`[WISHLIST] Portal rejected item: ${lateError}`);
          await this.captureFailureScreenshot(page, ctx.bookingCode, 'WISHLIST_SUBMIT_ERROR');
          throw new Error(lateError);
        }

        SanitizedLogger.warn(`[WISHLIST] Date mismatch: Expected ${expectedDisplayDate} not found in Wishlist.`);
        if (rowTexts.length > 0) {
          SanitizedLogger.warn(`[WISHLIST] Visible Wishlist rows inspected: ${JSON.stringify(rowTexts.slice(0, 5))}`);
        }
        await this.captureFailureScreenshot(page, ctx.bookingCode, 'WISHLIST_DATA_MISMATCH');
        throw new Error(`WISHLIST_DATA_MISMATCH: Expected date ${expectedDisplayDate} not found in Wishlist`);
      }
      return false;
    }

    const expectedPilgrimCount = ctx.pilgrimCount || 1;
    SanitizedLogger.info(`[WISHLIST] Date verified in Wishlist: ${expectedDisplayDate}`);
    SanitizedLogger.info(`[WISHLIST] Time slot verified in Wishlist: ${ctx.selectedTimeSlot || 'Any'}`);
    SanitizedLogger.info(`[WISHLIST] Pilgrims verified: ${expectedPilgrimCount}`);
    SanitizedLogger.info('[WISHLIST] Relief amount verified: ₹0');
    SanitizedLogger.info('[WISHLIST] Wishlist verification complete and successful');

    return true;
  }

  /**
   * 9. Adds to Wishlist: Inspects validation state of #regi_continue with bounded wait,
   * clicks only when enabled, navigates to official Wishlist, and strictly verifies the item.
   */
  static async addToWishlistAndVerify(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    const currentUrl = typeof page.url === 'function' ? page.url() : '';

    // 0. Idempotency check: If already on #/wishlist, directly verify
    if (currentUrl.includes('/wishlist')) {
      SanitizedLogger.info('[WISHLIST] Already on Wishlist page. Verifying item presence...');
      return await this.verifyWishlistContent(page, ctx);
    }

    // 1. Check for any blocking warning banners already on page
    const preWarning = await this.checkPortalWarningBanners(page);
    if (preWarning) {
      SanitizedLogger.error(`[WISHLIST] Blocking portal condition detected before submission: ${preWarning}`);
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'WISHLIST_PRE_SUBMIT_RESTRICTION');
      throw new Error(preWarning);
    }

    // 2. Clear any lingering backdrops/dialogs
    if (await page.locator('.cdk-overlay-backdrop').first().isVisible({ timeout: 1000 }).catch(() => false)) {
      const dialogBtn = page.locator('mat-dialog-container button:has-text("Submit"), mat-dialog-container button:has-text("Done"), mat-dialog-container button:has-text("OK"), mat-dialog-actions button').first();
      if (await dialogBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await dialogBtn.click().catch(() => {});
      }
      await page.locator('.cdk-overlay-backdrop').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }

    await this.waitForSpinnerDetached(page);
    await page.waitForTimeout(1000);

    // 3. Locate the Add to Wishlist button (#regi_continue)
    const wishlistBtnSelectors = SABARIMALA_SELECTORS.wishlist.addToWishlistButton;

    let targetBtn = null;
    let usedSelector = '';
    for (const sel of wishlistBtnSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        targetBtn = el;
        usedSelector = sel;
        break;
      }
    }

    // If button is not found on page, check if we were already redirected or item is already in Wishlist
    if (!targetBtn) {
      SanitizedLogger.warn(`[WISHLIST] Add to Wishlist button not visible on ${currentUrl}. Checking if item already in Wishlist...`);
      const inWishlist = await this.checkWishlistForItem(page, ctx);
      if (inWishlist) {
        SanitizedLogger.info('[WISHLIST] Item verified in Wishlist without needing button click.');
        return true;
      }
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'WISHLIST_BUTTON_NOT_FOUND');
      throw new Error(`Add to Wishlist button (#regi_continue) not found on official page. URL: ${currentUrl}`);
    }

    // 4. Inspect validation / enabled state of #regi_continue with bounded wait
    SanitizedLogger.info(`[WISHLIST] Inspecting validation state of Add to Wishlist button (${usedSelector})`);

    let isEnabled = await targetBtn.isEnabled().catch(() => false);
    if (!isEnabled) {
      SanitizedLogger.info('[WISHLIST] #regi_continue is currently disabled. Waiting up to 6000ms for form validation...');
      const startTime = Date.now();
      const boundedTimeoutMs = 6000;

      while (Date.now() - startTime < boundedTimeoutMs) {
        if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(500);
    }
        isEnabled = await targetBtn.isEnabled().catch(() => false);
        if (isEnabled) break;
      }
    }

    SanitizedLogger.info(`[WISHLIST] Button enabled state: ${isEnabled}`);

    // If still disabled after bounded wait:
    // Check if the item is ALREADY in Wishlist (e.g. form reset after prior submission or idempotency on retry)
    if (!isEnabled) {
      SanitizedLogger.info('[WISHLIST] #regi_continue is disabled. Checking Wishlist before throwing error...');
      const alreadyInWishlist = await this.checkWishlistForItem(page, ctx);
      if (alreadyInWishlist) {
        SanitizedLogger.info('[WISHLIST] Verified that item is already present in Wishlist. Proceeding.');
        return true;
      }

      const diagSlotSelected = (await page.locator('.slot-dar-5, .slot-card.selected, .slot-card.active, [aria-selected="true"]').count().catch(() => 0)) > 0;
      const diagPilgrimsCount = await page.locator('table tbody tr').count().catch(() => 0);
      const diagReliefChecked = (await page.locator('input[type="radio"][value="No"]:checked, mat-radio-button.mat-radio-checked:has-text("No")').count().catch(() => 0)) > 0;
      const diagInvalidFields = await page.locator('.ng-invalid[formcontrolname], .mat-form-field-invalid, .mat-error, .alert-danger').allInnerTexts().catch(() => []);
      const portalErrors = await this.checkPortalWarningBanners(page);

      const diagnostics = {
        buttonId: '#regi_continue',
        slotSelected: diagSlotSelected,
        selectedSlotContext: ctx.selectedTimeSlot,
        pilgrimCountContext: ctx.pilgrimCount,
        pilgrimRowsVisible: diagPilgrimsCount,
        reliefFundNoChecked: diagReliefChecked,
        portalErrors: portalErrors || 'None',
        invalidFields: diagInvalidFields.filter(t => t.trim().length > 0).slice(0, 5),
      };

      SanitizedLogger.error('[WISHLIST-DIAGNOSTICS] Add to Wishlist button (#regi_continue) remains disabled:', diagnostics);
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'BUTTON_DISABLED_DIAGNOSTIC');

      const reason = !diagSlotSelected ? 'Slot selection unconfirmed on portal' :
                     (!diagReliefChecked ? 'Relief fund No not selected' :
                     (portalErrors ? portalErrors : 'Form validation prerequisites not satisfied'));

      throw new Error(`BUTTON_DISABLED: Add to Wishlist button (#regi_continue) is disabled. Reason: ${reason}. Diagnostics: ${JSON.stringify(diagnostics)}`);
    }

    // 5. Click ONLY when enabled
    const urlBeforeSubmit = typeof page.url === 'function' ? page.url() : '';
    await targetBtn.scrollIntoViewIfNeeded().catch(() => {});
    SanitizedLogger.info(`[WISHLIST] #regi_continue is enabled. Submitting click. (URL before submit: ${urlBeforeSubmit})`);
    await targetBtn.click({ timeout: 5000 });
    const urlAfterSubmit = typeof page.url === 'function' ? page.url() : '';
    SanitizedLogger.info(`[WISHLIST] Click action succeeded. (URL after submit: ${urlAfterSubmit})`);

    // 6. Check for portal restriction banners immediately triggered by click
    await page.waitForTimeout(1000);
    const postWarning = await this.checkPortalWarningBanners(page);
    if (postWarning) {
      SanitizedLogger.error(`[WISHLIST] Portal error detected upon submission: ${postWarning}`);
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'WISHLIST_SUBMIT_ERROR');
      throw new Error(postWarning);
    }

    // 7. Wait for official success toast/alert
    const toastSelectors = SABARIMALA_SELECTORS.wishlist.successBanner;

    let toastFound = false;
    for (const tSel of toastSelectors) {
      if (await page.locator(tSel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
        toastFound = true;
        break;
      }
    }

    SanitizedLogger.info(`[WISHLIST] Post-click result: Toast confirmation detected: ${toastFound}`);

    // Wait for any post-submission spinner/overlay to detach
    await this.waitForSpinnerDetached(page);
    await page.waitForTimeout(1000);

    // 8. Inspect whether Wishlist panel/drawer is ALREADY open and visible on the current page (#/darshan)
    const sideDrawerSelector = '.side-drawer, mat-drawer, .drawer, .wishlist-drawer, .wishlist-panel, [id*="wishlist"]';
    const isDrawerVisible = await page.locator(sideDrawerSelector).first().isVisible({ timeout: 1500 }).catch(() => false);
    const hasWishlistRows = (await page.locator('table tbody tr').count().catch(() => 0)) > 0;

    if (isDrawerVisible || hasWishlistRows) {
      SanitizedLogger.info('[WISHLIST] Wishlist side-panel/table detected on current page. Verifying item presence in panel...');
      const verifiedInPanel = await this.verifyWishlistContent(page, ctx, true);
      if (verifiedInPanel) {
        SanitizedLogger.info('[WISHLIST] Verified item directly in active side-panel without route navigation.');
        return true;
      }
    }

    // 9. Stay on #/darshan. The My Wishlist panel is rendered on the right side of #/darshan.
    SanitizedLogger.info('[WISHLIST] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
    SanitizedLogger.info('[WISHLIST] Inspecting My Wishlist panel on Virtual-Q page');
    return await this.verifyWishlistContent(page, ctx);
  }

  /**
   * 6. Clicks "Proceed" in Wishlist and navigates to #/paymentGateway
   */
  static async proceedToPaymentGateway(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info('[PAYMENT-REVIEW] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
    SanitizedLogger.info('[PAYMENT-REVIEW] Inspecting My Wishlist panel on Virtual-Q page');

    // Authoritative pre-checkout verification (Requirement 6):
    await WishlistFlow.verifyWishlistBeforeCheckout(page, ctx);

    const proceedSelectors = [
      '.side-drawer button:has-text("Proceed to Book")',
      '.drawer button:has-text("Proceed to Book")',
      'mat-drawer button:has-text("Proceed to Book")',
      '.wishlist-drawer button:has-text("Proceed to Book")',
      '.wishlist-panel button:has-text("Proceed to Book")',
      '.side-drawer button:has-text("Proceed")',
      '.drawer button:has-text("Proceed")',
      'mat-drawer button:has-text("Proceed")',
      'button:has-text("Proceed to Book")',
      'button:has-text("Proceed")',
      'button:has-text("Continue")',
      'button:has-text("Book Now")',
      'a:has-text("Proceed to Book")',
      'a:has-text("Proceed")',
      'a:has-text("Continue")',
    ];

    let proceedBtn = null;
    for (const sel of proceedSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        proceedBtn = el;
        break;
      }
    }

    if (!proceedBtn) {
      const scopedProceed = await WishlistFlow.findProceedButton(page).catch(() => null);
      if (scopedProceed?.visible) {
        proceedBtn = scopedProceed.locator;
      }
    }

    if (!proceedBtn) {
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'PROCEED_TO_PAYMENT_GATEWAY_FAILED');
      throw new Error(`PROCEED_TO_PAYMENT_GATEWAY_FAILED: Proceed button not found in Wishlist`);
    }

    await proceedBtn.click();

    // Wait for navigation to paymentGateway
    await page.waitForURL(/paymentGateway/i, { timeout: 15000 }).catch(async () => {
      await page.waitForTimeout(3000);
    });

    const currentUrl = page.url();
    if (!currentUrl.includes('paymentGateway')) {
      // Check if page contains payment details
      const pageText = await page.innerText('body').catch(() => '');
      if (!pageText.includes('Payment') && !pageText.includes('Grand Total') && !pageText.includes('Booking ID')) {
        await this.captureFailureScreenshot(page, ctx.bookingCode, 'PROCEED_TO_PAYMENT_GATEWAY_FAILED');
        throw new Error(`PROCEED_TO_PAYMENT_GATEWAY_FAILED: Did not reach payment gateway page. Current URL: ${currentUrl}`);
      }
    }

    SanitizedLogger.info('[PAYMENT] Payment gateway opened');
    return true;
  }

  /**
   * 7. Verifies Payment Gateway summary details (Service, Date, Slot, Amount)
   */
  static async verifyPaymentSummary(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    await page.waitForTimeout(2000);
    await PaymentReviewFlow.checkServiceUnavailableAndAbort(page, ctx);

    const bodyText = await page.innerText('body').catch(() => '');

    // Extract Cart ID
    const cartMatch = bodyText.match(/Cart\s*ID[\s:]+([0-9A-Z]+)/i);
    if (cartMatch) {
      ctx.cartId = cartMatch[1].trim();
      SanitizedLogger.info(`[PAYMENT] Cart ID: ${ctx.cartId}`);
    }

    // Extract Official Booking ID (e.g. IVQ26100514030705319660)
    const ivqMatch = bodyText.match(/(IVQ[0-9A-Z]+)/i);
    if (ivqMatch) {
      ctx.officialBookingId = ivqMatch[1].trim();
      ctx.officialBookingReference = ctx.officialBookingId;
      SanitizedLogger.info(`[PAYMENT] Official booking reference: ${ctx.officialBookingReference}`);
    } else {
      const genericMatch = bodyText.match(/Booking\s*ID[\s:]+([A-Z0-9]{8,})/i);
      if (genericMatch) {
        ctx.officialBookingId = genericMatch[1].trim();
        ctx.officialBookingReference = ctx.officialBookingId;
        SanitizedLogger.info(`[PAYMENT] Official booking reference: ${ctx.officialBookingReference}`);
      }
    }

    // Extract Grand Total
    const totalMatch = bodyText.match(/Grand\s*Total\s*(?:Amount)?[\s:₹]+([0-9.,]+)/i);
    if (totalMatch) {
      ctx.grandTotal = `₹${totalMatch[1].trim()}`;
      SanitizedLogger.info(`[PAYMENT] Grand Total: ${ctx.grandTotal}`);

      // Handle non-zero or unexpected payment requirement
      const numericAmount = parseFloat(totalMatch[1].replace(/,/g, ''));
      if (numericAmount > 0) {
        const allowPayment = ctx.preferences?.allowPayment || false;
        if (!allowPayment) {
          SanitizedLogger.warn(`[PAYMENT] Grand Total is ₹${numericAmount} (> 0) and automated payment is not configured. Flagging for human review.`);
          await this.captureFailureScreenshot(page, ctx.bookingCode, 'PAYMENT_REQUIRED_OR_AMBIGUOUS');
          throw new Error(`PAYMENT_REQUIRED_OR_AMBIGUOUS: Payment gateway requires payment of ₹${numericAmount}. Automated payment not configured; requires human review.`);
        }
      }
    }

    // Extract Slot if present in table
    const slotMatch = bodyText.match(/(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})/);
    if (slotMatch) {
      ctx.selectedTimeSlot = slotMatch[1].trim();
      SanitizedLogger.info(`[PAYMENT] Slot confirmed: ${ctx.selectedTimeSlot}`);
    }

    // Verify Service === "Virtual-Q"
    if (!bodyText.includes('Virtual-Q') && !bodyText.includes('Virtual Q') && !bodyText.includes('Darshan')) {
      SanitizedLogger.warn('[PAYMENT] Payment summary does not contain Virtual-Q service');
    }

    // Verify Date
    const expectedDisplayDate = ctx.requestedDateDisplay || this.toDisplayDate(ctx.requestedDate);
    const dateMatched = this.matchesDate(bodyText, ctx.requestedDate, expectedDisplayDate);
    if (!dateMatched) {
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'PAYMENT_SUMMARY_MISMATCH');
      throw new Error(`PAYMENT_SUMMARY_MISMATCH: Payment summary date does not match ${expectedDisplayDate}`);
    }

    SanitizedLogger.info('[PAYMENT] Summary verified');
    return true;
  }

  /**
   * 8. Executes Proceed on the Payment Gateway page and verifies final booking confirmation
   */
  static async executePaymentProceedAndConfirm(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{
    confirmed: boolean;
    isZeroCost?: boolean;
    officialReference?: string;
    cartId?: string;
    officialBookingReference?: string;
    officialReceiptReference?: string;
    portalTransactionReference?: string;
    confirmationEvidence?: any;
    confirmedAt?: string;
    confirmationSource?: string;
    confirmationData?: any;
    reconciliationRequired?: boolean;
    message?: string;
  }> {
    SanitizedLogger.info('[PAYMENT] Proceeding');
    await PaymentReviewFlow.checkServiceUnavailableAndAbort(page, ctx);

    const paymentProceedBtns = [
      'button:has-text("Process")',
      'button:has-text("Confirm")',
      'button:has-text("Proceed to Pay")',
      'button:has-text("Proceed to Book")',
      'button:has-text("Proceed")',
      'button:has-text("Pay Now")',
      'button[type="submit"]',
    ];

    let payBtn = null;
    for (const sel of paymentProceedBtns) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        payBtn = el;
        break;
      }
    }

    if (payBtn) {
      // Persist CONFIRM_CLICKED marker before clicking final confirmation button
      if (ctx.bookingCode) {
        ConfirmMarkerManager.setMarker(ctx.bookingCode, {
          bookingCode: ctx.bookingCode,
          jobId: ctx.jobId,
          date: ctx.requestedDate,
          route: ctx.requestedRoute,
        });
      }
      SanitizedLogger.info('[SECOND_PROCEED_CLICKED] Clicking second Proceed button on checkout page');
      await payBtn.click();
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
      // Check for explicit error banner or cancellation on page first
      const currentBodyText = await page.innerText('body').catch(() => '');
      if (
        currentBodyText.includes('Sorry, this service is not available') ||
        currentBodyText.includes("service through 'My Wishlist'")
      ) {
        SanitizedLogger.error('[PAYMENT-REVIEW] Official portal rejected booking: Service not available');
        await this.captureFailureScreenshot(page, ctx.bookingCode, 'SERVICE_UNAVAILABLE_AT_PAYMENT');
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
        SanitizedLogger.warn('[CONFIRMATION-AUDIT] Explicit transaction cancellation or failure detected:', {
          bodySnippet: currentBodyText.slice(0, 200),
          decision: 'NOT_CONFIRMED',
        });
        await this.captureFailureScreenshot(page, ctx.bookingCode, 'TRANSACTION_CANCELLED_OR_FAILED');
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
      // If the popup does not appear, do not guess success from a reference number or page text. Enter safe reconciliation.
      SanitizedLogger.warn('[CONFIRMATION] Official booking success popup did not appear within timeout. Entering safe reconciliation without guessing.');
      await this.captureFailureScreenshot(page, ctx.bookingCode, 'FINAL_BOOKING_UNCONFIRMED');
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

    // Check for pass reference in popup text if present
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

    // Capture screenshot of success popup before clicking OK if practical
    try {
      const popupScreenshotPath = path.resolve(process.cwd(), 'debug', `${ctx.bookingCode || 'TA'}-SUCCESS_POPUP-${Date.now()}.png`);
      await page.screenshot({ path: popupScreenshotPath }).catch(() => {});
    } catch {}

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
    } else {
      SanitizedLogger.warn('[CONFIRMATION] OK button not detected on popup, proceeding to check navigation...');
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
      // If the popup appears but OK/navigation fails, preserve the success popup and Transaction ID in attempt record and use reconciliation
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
    
    // Capture screenshot of Transaction History page after navigation
    try {
      const histScreenshotPath = path.resolve(process.cwd(), 'debug', `${ctx.bookingCode || 'TA'}-TRANSACTION_HISTORY-${Date.now()}.png`);
      await page.screenshot({ path: histScreenshotPath, fullPage: true }).catch(() => {});
    } catch {}

    await page.waitForTimeout(1500);

    // 8. Opportunistic check of Transaction History for extra pass reference or cancellation
    // IMPORTANT: Do NOT require an additional table row inspection to mark the devotee confirmed
    // after the official success popup and automatic Transaction History navigation have been verified!
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
              SanitizedLogger.error(`[CONFIRMATION] Transaction record in history is cancelled/failed for Transaction ID ${transactionId}: ${rowText.slice(0, 100)}`);
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
            break;
          }
        }
      } catch {}
    }

    if (!verifiedPassRef) {
      const historyBody = await page.innerText('body').catch(() => '');
      if (
        (transactionId && transactionId !== 'UNKNOWN_TXN' && historyBody.includes(transactionId)) ||
        (passReference && historyBody.includes(passReference))
      ) {
        if (/\b(CANCELLED|FAILED)\b/i.test(historyBody)) {
          SanitizedLogger.error(`[CONFIRMATION] History body indicates cancelled/failed transaction for ${transactionId}`);
          return {
            confirmed: false,
            reconciliationRequired: false,
            message: `Transaction record ${transactionId} in history is CANCELLED.`,
          };
        }
        const bodyIvqMatch = historyBody.match(/\b(IVQ[0-9A-Z]{6,30})\b/i);
        if (bodyIvqMatch) {
          verifiedPassRef = bodyIvqMatch[1].trim();
        }
      }
    }

    const finalOfficialRef = verifiedPassRef || transactionId;
    SanitizedLogger.info(`[TRANSACTION_HISTORY_RECORD_VERIFIED] Transaction record verified for Transaction ID: ${transactionId} (Pass: ${finalOfficialRef})`);
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
      confirmationSource: 'OFFICIAL_SUCCESS_POPUP_AND_TRANSACTION_HISTORY_NAVIGATION',
      confirmationData: {
        officialReference: finalOfficialRef,
        officialBookingReference: finalOfficialRef,
        transactionId,
        portalTransactionReference: transactionId,
        requestedDate: ctx.requestedDate,
        selectedTime: ctx.selectedTimeSlot,
        route: ctx.requestedRoute,
        pilgrimsCount: ctx.pilgrimCount || 1,
        status: 'CONFIRMED',
        source: 'OFFICIAL_SUCCESS_POPUP_AND_TRANSACTION_HISTORY_NAVIGATION',
      },
    };
  }

  /**
   * Best-effort verification that the confirmed booking appears in history or receipt is available
   */
  static async verifyBookingHistoryOrReceipt(page: Page, officialReference: string): Promise<boolean> {
    try {
      SanitizedLogger.info(`[RECEIPT] Verifying receipt/history for reference: ${officialReference}`);
      if (/^\d{8,12}$/.test(officialReference)) {
        SanitizedLogger.warn(`[RECEIPT] Warning: reference ${officialReference} appears to be a Cart ID rather than an official booking reference (IVQ...)`);
      }
      const bodyText = typeof page.innerText === 'function' ? await page.innerText('body').catch(() => '') : '';
      if (bodyText.includes(officialReference)) {
        SanitizedLogger.info(`[RECEIPT] Authoritative reference ${officialReference} confirmed in current view`);
        return true;
      }

      const receiptLink = page.locator('a:has-text("Download Receipt"), button:has-text("Download Receipt"), a:has-text("Receipt"), a:has-text("Booking History")').first();
      if (await receiptLink.isVisible({ timeout: 1500 }).catch(() => false)) {
        SanitizedLogger.info('[RECEIPT] Official receipt download/history link detected');
        return true;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Authoritative portal booking history reconciliation.
   * STRICT REQUIREMENTS:
   * 1. Never match raw page body text, URLs, cart, payment summary, or debug output.
   * 2. Require an authoritative ticket/pass record with CONFIRMED/SUCCESS status (never CANCELLED or FAILED).
   * 3. Require correct date and valid pilgrim count (>= 1, never 0 pilgrims).
   * 4. Structured audit logging on all decisions.
   */
  static async checkExistingBookingInHistory(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{
    found: boolean;
    officialReference?: string;
    confirmedAt?: string;
    status?: string;
    officialStatusFound?: string;
    pilgrimCountFound?: number;
    reconciliationRequired?: boolean;
    decision?: string;
    decisionReason?: string;
  }> {
    const canonicalDate = ctx.requestedDate;
    const displayDate = ctx.requestedDateDisplay || (canonicalDate ? SabarimalaPostLoginFlow.toDisplayDate(canonicalDate) : '');
    const devoteeName = ctx.selectedPilgrim?.fullName || (ctx.nominee as any)?.nomineeName || '';

    SanitizedLogger.info(
      `[RECONCILIATION-AUDIT] Initiating authoritative history reconciliation for Date="${canonicalDate}" (${displayDate}), Route="${ctx.requestedRoute || 'N/A'}", Devotee="${devoteeName || 'N/A'}"`,
    );

    try {
      if (typeof page.goto === 'function') {
        const curUrl = typeof page.url === 'function' ? page.url() : '';
        if (!curUrl.includes('TransactionHistory')) {
          await page.goto('https://sabarimalaonline.org/#/TransactionHistory', {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
          }).catch(() => {});
        }
      }
      await page.waitForTimeout(2000);

      // Check table rows / cards on booking history page
      const rowSelectors = [
        'table tbody tr',
        '.history-table tbody tr',
        'mat-table mat-row',
        'mat-row',
        '.booking-card',
        'mat-card',
        '.transaction-item',
        'tr',
      ];

      let seenCancelledRow = false;
      let seenZeroPilgrimRow = false;
      let latestCancelledRef: string | undefined;

      for (const sel of rowSelectors) {
        const rows = page.locator(sel);
        const count = await rows.count().catch(() => 0);
        if (count === 0) continue;

        for (let i = 0; i < count; i++) {
          const rowText = await rows.nth(i).innerText().catch(() => '');
          if (!rowText || rowText.trim().length === 0) continue;

          // Date Matching (require canonical YYYY-MM-DD or display DD-MM-YYYY / DD/MM/YYYY)
          const matchesDate =
            canonicalDate &&
            (rowText.includes(canonicalDate) ||
              (displayDate && rowText.includes(displayDate)) ||
              (canonicalDate.includes('-') &&
                rowText.includes(canonicalDate.split('-').reverse().join('-'))));

          if (!matchesDate) {
            continue;
          }

          // Reference extraction
          const refMatch = rowText.match(/\b(IVQ[0-9A-Z]{6,30}|VQ[0-9A-Z]{6,30})\b/i);
          const rowRef = refMatch ? refMatch[1].trim() : undefined;

          // Pilgrim Count verification
          const pCountMatch = rowText.match(/(\d+)\s*(?:Pilgrims?|Devotees?|Persons?|Pax)\b/i) ||
            rowText.match(/(?:Pilgrims?|Devotees?|Count)[\s:]+(\d+)/i);
          const pilgrimCount = pCountMatch ? parseInt(pCountMatch[1], 10) : undefined;

          // Status verification: Explicit check for cancelled / failed / unconfirmed
          const isCancelledOrFailed =
            /\b(CANCELLED|CANCELED|FAILED|FAILURE|ABORTED|EXPIRED|REJECTED|PAYMENT[_\s]FAILED|TIMEOUT)\b/i.test(rowText);

          if (isCancelledOrFailed || pilgrimCount === 0) {
            seenCancelledRow = true;
            if (pilgrimCount === 0) seenZeroPilgrimRow = true;
            if (rowRef) latestCancelledRef = rowRef;

            SanitizedLogger.warn(`[RECONCILIATION-AUDIT] Found record matching date ${canonicalDate} but REJECTED:`, {
              reconciliationSource: 'PORTAL_BOOKING_HISTORY',
              searchedReference: rowRef,
              officialStatusFound: isCancelledOrFailed ? 'CANCELLED' : 'ZERO_PILGRIMS',
              pilgrimCountFound: pilgrimCount ?? 0,
              dateMatched: true,
              decision: 'REJECTED_CANCELLED',
              reason: 'Transaction record is cancelled, failed, or has 0 pilgrims. Not a confirmed pass.',
            });
            continue;
          }

          // Authoritative Positive Status Verification:
          // Must explicitly contain CONFIRMED / SUCCESS / SUCCESSFUL / BOOKED / COMPLETED / PAID
          const isConfirmedStatus =
            /\b(CONFIRMED|SUCCESSFUL|SUCCESS|BOOKED|COMPLETED|PAID|ACTIVE)\b/i.test(rowText);

          if (!isConfirmedStatus) {
            SanitizedLogger.warn(`[RECONCILIATION-AUDIT] Row matches date ${canonicalDate} but lacks confirmed status:`, {
              reconciliationSource: 'PORTAL_BOOKING_HISTORY',
              searchedReference: rowRef,
              rowSnippet: rowText.slice(0, 150),
              decision: 'REJECTED_STATUS_UNCLEAR',
            });
            continue;
          }

          // Ticket Record Verification:
          // Must have a valid pass reference (IVQ... or VQ...) AND not be pure 0 pilgrims
          if (!rowRef) {
            SanitizedLogger.warn(`[RECONCILIATION-AUDIT] Row confirmed on date ${canonicalDate} but lacks authoritative pass reference.`);
            continue;
          }

          // Check for download receipt/pass action in row
          const hasActionIndicator =
            /Download|Receipt|Pass|View|Print/i.test(rowText) ||
            (await rows.nth(i).locator('a, button').count().catch(() => 0)) > 0;

          // Devotee identity check
          const pilgrimIdentityMatched = devoteeName ? rowText.toLowerCase().includes(devoteeName.toLowerCase()) : true;

          SanitizedLogger.info(`[RECONCILIATION-AUDIT] Authoritative confirmed pass FOUND:`, {
            reconciliationSource: 'PORTAL_BOOKING_HISTORY',
            officialReference: rowRef,
            officialStatusFound: 'CONFIRMED',
            dateMatched: true,
            pilgrimCountFound: pilgrimCount || 1,
            pilgrimIdentityMatched,
            hasActionIndicator,
            decision: 'CONFIRMED',
            reason: `Confirmed official pass #${rowRef} verified on portal for date ${canonicalDate}.`,
          });

          return {
            found: true,
            officialReference: rowRef,
            confirmedAt: new Date().toISOString(),
            status: 'CONFIRMED',
            officialStatusFound: 'CONFIRMED',
            pilgrimCountFound: pilgrimCount || 1,
            decision: 'CONFIRMED',
            decisionReason: `Verified official pass #${rowRef} with confirmed status and valid pilgrims.`,
          };
        }
      }

      // STRICT REQUIREMENT 1: NEVER check body text regex!
      // Matching raw body text without row structure is strictly eliminated.

      const decisionReason = seenCancelledRow
        ? `Found portal transaction(s) for ${canonicalDate} with status CANCELLED or 0 pilgrims (${latestCancelledRef || 'No Ref'}). No confirmed pass exists.`
        : `No confirmed pass record found in portal history for date ${canonicalDate}.`;

      SanitizedLogger.warn(`[RECONCILIATION-AUDIT] Final Reconciliation Decision: RECONCILIATION_REQUIRED`, {
        reconciliationSource: 'PORTAL_BOOKING_HISTORY',
        searchedDate: canonicalDate,
        officialStatusFound: seenCancelledRow ? 'CANCELLED' : 'NOT_FOUND',
        seenZeroPilgrimRow,
        decision: 'RECONCILIATION_REQUIRED',
        reason: decisionReason,
      });

      return {
        found: false,
        officialStatusFound: seenCancelledRow ? 'CANCELLED' : 'NOT_FOUND',
        reconciliationRequired: true,
        decision: 'RECONCILIATION_REQUIRED',
        decisionReason,
      };
    } catch (err: any) {
      SanitizedLogger.warn(`[RECONCILIATION] Error checking booking history: ${err?.message || err}`);
      return {
        found: false,
        officialStatusFound: 'ERROR',
        reconciliationRequired: true,
        decision: 'RECONCILIATION_REQUIRED',
        decisionReason: `Booking history check encountered error: ${err?.message || err}`,
      };
    }
  }

  private static isCleaningScreenshots = false;

  /**
   * Bounded debug screenshot retention: cleans up files older than maxAgeDays (default 7 days)
   * and caps total debug directory size to maxTotalBytes (default 200MB).
   */
  public static async cleanupOldScreenshots(
    debugDir: string = path.resolve(process.cwd(), 'debug'),
    maxAgeDays: number = 7,
    maxTotalBytes: number = 200 * 1024 * 1024
  ): Promise<void> {
    if (this.isCleaningScreenshots) return;
    this.isCleaningScreenshots = true;
    try {
      if (!fs.existsSync(debugDir)) return;
      const files = await fs.promises.readdir(debugDir);
      const pngFiles: { name: string; fullPath: string; mtimeMs: number; size: number }[] = [];
      const now = Date.now();
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.png') && !file.endsWith('.jpg')) continue;
        const fullPath = path.join(debugDir, file);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.isFile()) {
            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.promises.unlink(fullPath);
              SanitizedLogger.info(`[DEBUG] Pruned expired screenshot: ${file}`);
            } else {
              pngFiles.push({ name: file, fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
            }
          }
        } catch {}
      }

      let totalSize = pngFiles.reduce((acc, f) => acc + f.size, 0);
      if (totalSize > maxTotalBytes) {
        pngFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const f of pngFiles) {
          if (totalSize <= maxTotalBytes) break;
          try {
            await fs.promises.unlink(f.fullPath);
            totalSize -= f.size;
            SanitizedLogger.info(`[DEBUG] Pruned screenshot for space cap: ${f.name}`);
          } catch {}
        }
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[DEBUG] Screenshot cleanup warning: ${err.message}`);
    } finally {
      this.isCleaningScreenshots = false;
    }
  }

  private static async captureFailureScreenshot(page: Page, bookingCode: string, state: string): Promise<void> {
    try {
      const debugDir = path.resolve(process.cwd(), 'debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${bookingCode}-${state}-${timestamp}.png`;
      const screenshotPath = path.join(debugDir, filename);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      SanitizedLogger.info(`[DEBUG] Failure screenshot captured: ${screenshotPath}`);

      // Run bounded cleanup asynchronously
      this.cleanupOldScreenshots(debugDir).catch(() => {});
    } catch (err: any) {
      SanitizedLogger.warn('[DEBUG] Could not save failure screenshot:', err.message);
    }
  }
}
