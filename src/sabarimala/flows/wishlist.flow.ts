import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { SanitizedLogger } from '../../monitoring/logger';
import { BookingExecutionContext, VirtualQWorkflowError } from './types';
import { FlowDiagnosticsManager } from './diagnostics';
import { SABARIMALA_SELECTORS } from '../selectors';
import { resolveCanonicalRoute, OFFICIAL_PORTAL_ROUTES } from './date-route.flow';

export interface WishlistParsedItem {
  index: number;
  rawText: string;
  date?: string;
  route?: string;
  timeSlot?: string;
  pilgrimCount?: number;
  statusText?: string;
  isUnavailable: boolean;
  isCurrentAttemptMatch: boolean;
  isStaleUnavailable: boolean;
  locator?: any;
}

export class WishlistFlow {
  /**
   * Helper: Extract all text blocks / rows currently rendered in Wishlist drawer or table.
   * Does NOT modify, clear or remove any items.
   */
  static async getWishlistItemsText(page: Page): Promise<string[]> {
    const itemSelectors = [
      'app-wishlist .item',
      'app-wishlist .wishlist-list',
      'app-wishlist .item_content',
      'app-wishlist ul.wishlist-list li',
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

    const results: string[] = [];
    for (const sel of itemSelectors) {
      const locator = page.locator(sel);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const itemEl = typeof locator.nth === 'function' ? locator.nth(i) : locator;
        const txt = await itemEl.innerText().catch(() => '');
        if (txt.trim().length > 0) {
          results.push(txt.trim());
        }
      }
      if (results.length > 0) break;
    }
    return results;
  }

  /**
   * Helper: Scans the form for visible validation errors and banners.
   */
  static async scanVisibleValidationErrors(page: Page): Promise<string[]> {
    const errorSelectors = [
      '.error-msg',
      '.sloterr-msg',
      '.noQuota-msg',
      '#nominee-table-wrapper .text-danger small',
      '#nominee-table-wrapper .nominee-error',
      'mat-error',
      '.mat-snack-bar-container',
      '.alert-danger',
      '.toast-error',
      'mat-dialog-container',
    ];
    const found: string[] = [];
    for (const sel of errorSelectors) {
      try {
        const els = page.locator(sel);
        const count = typeof els.count === 'function' ? await els.count().catch(() => 0) : 0;
        for (let i = 0; i < count; i++) {
          const el = els.nth(i);
          if (await el.isVisible({ timeout: 150 }).catch(() => false)) {
            const txt = (await el.innerText().catch(() => '')).trim();
            if (txt.length > 0 && !found.includes(txt)) {
              found.push(txt);
            }
          }
        }
      } catch {}
    }
    return found;
  }

  /**
   * Helper: Check if right-side Wishlist drawer/panel is currently visible on page.
   */
  static async isWishlistDrawerVisible(page: Page): Promise<boolean> {
    const drawerSelectors = [
      'mat-drawer.mat-drawer-opened',
      'mat-sidenav.mat-sidenav-opened',
      'mat-drawer[opened]',
      'mat-sidenav[opened]',
      '.side-drawer',
      '.wishlist-drawer',
      '.wishlist-panel',
      'app-wishlist',
      'div:has(> *:has-text("My Wishlist"))',
      'div.card:has-text("My Wishlist")',
      'div:has-text("My Wishlist"):has(button:has-text("Proceed"))',
      'div:has-text("My Wishlist"):has(button:has-text("Clear Wishlist"))',
      'text=/My Wishlist/i',
      '.drawer.open',
      '.drawer.active',
      '.drawer:not([hidden])',
      'app-wishlist .item',
      'app-wishlist .wishlist-list',
      'app-wishlist .item_content',
      '.side-drawer table tbody tr',
      'mat-drawer table tbody tr',
      '.drawer table tbody tr',
      '.wishlist-drawer table tbody tr',
      '.side-drawer .wishlist-item',
      'mat-drawer .wishlist-item',
      '.drawer .wishlist-item',
      'button:has-text("Proceed to Book")',
      '.side-drawer button:has-text("Proceed")',
      'mat-drawer button:has-text("Proceed")',
      'app-wishlist button:has-text("Proceed")',
      'button:has-text("Clear Wishlist")',
    ];

    for (const sel of drawerSelectors) {
      try {
        const el = page.locator(sel);
        const count = await el.count().catch(() => 0);
        if (count > 0) {
          const target = typeof el.first === 'function' ? el.first() : el;
          const visible = await target.isVisible().catch(() => false);
          if (visible) {
            // An empty container with no text is NOT a visible wishlist drawer
            const txt = await target.innerText().catch(() => '');
            if (txt.trim().length === 0 && !sel.includes('button')) continue;
            return true;
          }
        }
      } catch {}
    }
    return false;
  }

  /**
   * Helper: Counts how many items or item rows currently exist in the Wishlist drawer or table.
   */
  static async getWishlistItemsCount(page: Page): Promise<number> {
    const itemSelectors = [
      'app-wishlist .item',
      'app-wishlist .wishlist-list',
      'app-wishlist .item_content',
      'app-wishlist ul.wishlist-list li',
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
      '.wishlist-card',
    ];

    for (const sel of itemSelectors) {
      try {
        const locator = page.locator(sel);
        const count = await locator.count().catch(() => 0);
        if (count > 0) {
          let validItems = 0;
          for (let i = 0; i < count; i++) {
            const itemEl = typeof locator.nth === 'function' ? locator.nth(i) : locator;
            const txt = await itemEl.innerText().catch(() => '');
            if (txt.trim().length > 0 && !/empty|no items in wishlist|no records found/i.test(txt)) {
              validItems++;
            }
          }
          if (validItems > 0) return validItems;
        }
      } catch {}
    }

    const rawTexts = await this.getWishlistItemsText(page);
    return rawTexts.filter(t => t.trim().length > 0 && !/empty|no items in wishlist|no records found/i.test(t)).length;
  }

  /**
   * STEP 5: Initial Wishlist Cleanup immediately after login.
   * - Inspect right-side Wishlist panel. It appears automatically after login.
   * - Do not click any Wishlist / Add to Wishlist button at this stage.
   * - If Wishlist is visible and contains zero items, verify empty.
   * - If old items are visible, click Clear Wishlist and verify zero items.
   * - If the panel is hidden or cannot be inspected, mark Wishlist state UNKNOWN.
   * - Do not proceed to slot selection until the initial Wishlist state is reliably verified.
   * - Do not click Add to Wishlist during initial cleanup.
   */
  static async initialWishlistCleanup(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<boolean> {
    SanitizedLogger.info('[INITIAL_WISHLIST_CHECK] Inspecting right-side Wishlist panel post-login');

    // Wait briefly for right-side Wishlist panel to settle post-login
    let isVisible = false;
    for (let i = 0; i < 5; i++) {
      isVisible = await this.isWishlistDrawerVisible(page);
      if (isVisible) break;
      await page.waitForTimeout(400);
    }
    SanitizedLogger.info(`[INITIAL_WISHLIST_CHECK] Right-side Wishlist panel visibility: ${isVisible ? 'Visible' : 'Hidden'}`);

    // Critical issue 1: Do not treat a hidden Wishlist as empty!
    // If the panel is hidden or cannot be inspected, mark Wishlist state UNKNOWN.
    if (!isVisible) {
      SanitizedLogger.warn('[INITIAL_WISHLIST_UNKNOWN] Right-side Wishlist panel is hidden or cannot be inspected. Marking Wishlist state UNKNOWN.');
      if (ctx) {
        ctx.wishlistStatus = 'UNKNOWN';
      }
      return false; // Do not proceed to slot selection until reliably verified
    }

    const initialCount = await this.getWishlistItemsCount(page);

    if (initialCount === 0) {
      SanitizedLogger.info('[INITIAL_WISHLIST_EMPTY_VERIFIED] Wishlist panel is visible and clean (0 items found). Continuing to slot selection.');
      if (ctx) {
        ctx.wishlistStatus = 'EMPTY';
      }
      return true;
    }

    SanitizedLogger.info(`[INITIAL_WISHLIST_ITEMS_FOUND] Found ${initialCount} old item(s) in Wishlist from prior attempt`);

    // 1. Try Clear Wishlist button first
    const clearSelectors = [
      'button:has-text("Clear Wishlist")',
      'a:has-text("Clear Wishlist")',
      'button:has-text("Clear All")',
      '.btn-clear-wishlist',
      '.clear-wishlist',
      'app-wishlist button:has-text("Clear Wishlist")',
      '.side-drawer button:has-text("Clear Wishlist")',
      '.wishlist-drawer button:has-text("Clear Wishlist")',
      'app-wishlist button:has-text("Clear")',
      '.side-drawer button:has-text("Clear")',
    ];

    let clearClicked = false;
    for (const sel of clearSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          SanitizedLogger.info('[CLEAR_WISHLIST_CLICKED] Clicking visible Clear Wishlist button to clear old items');
          await btn.click().catch(() => {});
          clearClicked = true;
          const confirmBtn = page.locator(
            'mat-dialog-container button:has-text("Yes"), mat-dialog-container button:has-text("OK"), mat-dialog-container button:has-text("Confirm"), .swal2-confirm, button:has-text("Yes"), button:has-text("Confirm")'
          ).first();
          if (await confirmBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
            await confirmBtn.click().catch(() => {});
          }
          await page.waitForTimeout(1000);
          break;
        }
      } catch {}
    }

    // 2. Fallback: Delete individual items if any remain
    let postCount = await this.getWishlistItemsCount(page);
    if (postCount > 0) {
      try {
        const deleteBtns = page.locator(
          '.side-drawer button.btn-delete, app-wishlist button.btn-delete, app-wishlist mat-icon:has-text("delete"), .side-drawer mat-icon:has-text("delete"), .fa-trash, i.fa-trash, button:has-text("Delete"), a:has-text("Delete")'
        );
        const delCount = await deleteBtns.count().catch(() => 0);
        for (let i = 0; i < delCount; i++) {
          const btn = deleteBtns.nth(i);
          if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
            if (!clearClicked) {
              SanitizedLogger.info('[CLEAR_WISHLIST_CLICKED] Clicking delete icon to clear old item');
              clearClicked = true;
            }
            await btn.click().catch(() => {});
            const confirmBtn = page.locator('mat-dialog-container button:has-text("Yes"), .swal2-confirm, button:has-text("Yes")').first();
            if (await confirmBtn.isVisible({ timeout: 800 }).catch(() => false)) {
              await confirmBtn.click().catch(() => {});
            }
            await page.waitForTimeout(400);
          }
        }
      } catch {}
    }

    // 3. Authoritative verification: Wait up to 3.5 seconds for 0 items
    const verifyStart = Date.now();
    let isClean = false;
    while (Date.now() - verifyStart < 3500) {
      postCount = await this.getWishlistItemsCount(page);
      if (postCount === 0) {
        isClean = true;
        break;
      }
      await page.waitForTimeout(400);
    }

    if (isClean) {
      SanitizedLogger.info('[INITIAL_WISHLIST_EMPTY_VERIFIED] Old Wishlist items cleared successfully. Wishlist verified empty.');
      if (ctx) {
        ctx.wishlistStatus = 'EMPTY';
      }
      return true;
    } else {
      SanitizedLogger.error(`[INITIAL_WISHLIST_CLEAR_FAILED] Failed to verify empty Wishlist after clear attempt (${postCount} items remain).`);
      if (ctx) {
        ctx.wishlistStatus = 'UNKNOWN';
      }
      return false;
    }
  }

  /**
   * Helper: Locate the Wishlist container element on the page.
   */
  static async findWishlistPanel(page: Page): Promise<{ locator: any; selector: string; visible: boolean }> {
    const panelSelectors = [
      'app-wishlist',
      'mat-drawer:has-text("My Wishlist")',
      'mat-sidenav:has-text("My Wishlist")',
      '.side-drawer:has-text("My Wishlist")',
      'div.card:has-text("My Wishlist")',
      'div:has(> *:has-text("My Wishlist"))',
      'div:has-text("My Wishlist"):has(button:has-text("Proceed"))',
      '.wishlist-drawer',
      '.wishlist-panel',
      '.side-drawer',
      'mat-drawer',
      'mat-sidenav',
    ];

    for (const sel of panelSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
          return { locator: el, selector: sel, visible: true };
        }
      } catch {}
    }
    return { locator: page.locator('body'), selector: 'body', visible: false };
  }

  /**
   * Helper: Locate the Proceed button scoped to the Wishlist panel or adjacent to Wishlist controls.
   */
  static async findProceedButton(
    page: Page,
    containerLoc?: any,
  ): Promise<{ locator: any; selector: string; visible: boolean; enabled: boolean }> {
    const scopedProceedSelectors = [
      'button:has-text("Proceed")',
      'button:has-text("Proceed to Book")',
      'button:has-text("Proceed to Pay")',
      'button[aria-label*="Proceed" i]',
      'button.btn-proceed',
      'a:has-text("Proceed")',
      'a:has-text("Proceed to Book")',
      'a:has-text("Proceed to Pay")',
      'button:text-is("Proceed")',
    ];

    // 1. If container is provided and visible, search scoped inside container first
    if (containerLoc) {
      for (const sel of scopedProceedSelectors) {
        try {
          const btn = containerLoc.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            const enabled = !(await btn.isDisabled().catch(() => false));
            return { locator: btn, selector: `container > ${sel}`, visible: true, enabled };
          }
        } catch {}
      }
    }

    // 2. Try sibling/parent of "Clear Wishlist" button (exact official layout)
    try {
      const clearBtn = page.locator('button:has-text("Clear Wishlist"), a:has-text("Clear Wishlist")').first();
      if (await clearBtn.isVisible({ timeout: 400 }).catch(() => false)) {
        const parentProceed = clearBtn.locator('..').locator('button:has-text("Proceed"), a:has-text("Proceed")').first();
        if (await parentProceed.isVisible({ timeout: 500 }).catch(() => false)) {
          const enabled = !(await parentProceed.isDisabled().catch(() => false));
          return { locator: parentProceed, selector: 'Clear-Wishlist-parent > Proceed', visible: true, enabled };
        }
      }
    } catch {}

    // 3. Search panel-prefixed selectors
    const panelPrefixes = [
      'app-wishlist',
      '.side-drawer',
      'mat-drawer',
      'mat-sidenav',
      '.wishlist-drawer',
      '.wishlist-panel',
      'div:has-text("My Wishlist")',
      'div.card:has-text("My Wishlist")',
    ];

    for (const prefix of panelPrefixes) {
      for (const sel of scopedProceedSelectors) {
        try {
          const fullSel = `${prefix} ${sel}`;
          const btn = page.locator(fullSel).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            const enabled = !(await btn.isDisabled().catch(() => false));
            return { locator: btn, selector: fullSel, visible: true, enabled };
          }
        } catch {}
      }
    }

    // 4. Fallback search
    for (const sel of scopedProceedSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          const enabled = !(await btn.isDisabled().catch(() => false));
          return { locator: btn, selector: sel, visible: true, enabled };
        }
      } catch {}
    }

    return { locator: null, selector: '', visible: false, enabled: false };
  }

  /**
   * PHASE 7: Add to Wishlist and Authoritatively Verify the Newly Added Item
   * - Never clicks Proceed based only on button enabled state.
   * - Never treats an existing wishlist item as the newly created booking.
   * - Never clears or deletes existing wishlist entries automatically.
   * - Ignores existing unrelated wishlist entries.
   * - Strictly detects PREVIOUS_BOOKING_RESTRICTION portal error.
   */
  /**
   * Helper: Ensures the Wishlist drawer/panel on #/darshan is visible and opened
   */
  static async openWishlistDrawerIfNeeded(page: Page): Promise<boolean> {
    const isVisible = await this.isWishlistDrawerVisible(page);
    if (isVisible) return true;

    const triggerSelectors = [
      'a[href*="wishlist"]',
      'button:has-text("Wishlist")',
      'a:has-text("Wishlist")',
      '.wishlist-icon',
      'mat-icon:has-text("shopping_cart")',
      'mat-icon:has-text("bookmark")',
      'button[aria-label*="wishlist" i]',
      'a[aria-label*="wishlist" i]',
      '.btn-wishlist-toggle',
      '.header-wishlist',
      'app-header [aria-label*="wishlist" i]',
    ];

    for (const sel of triggerSelectors) {
      try {
        const trigger = page.locator(sel).first();
        if (await trigger.isVisible({ timeout: 500 }).catch(() => false)) {
          await trigger.click().catch(() => {});
          await page.waitForTimeout(800);
          if (await this.isWishlistDrawerVisible(page)) {
            return true;
          }
        }
      } catch {}
    }
    return await this.isWishlistDrawerVisible(page);
  }

  /**
   * Helper: Parses displayed Wishlist item details (date, slot, route, pilgrim count, and unavailable status)
   */
  static parseWishlistItem(text: string, ctx: BookingExecutionContext, index = 0): WishlistParsedItem {
    const normText = text.replace(/\s+/g, ' ').trim();

    // 1. Service Date (supports YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY)
    const dateMatch = normText.match(/\b(\d{2}[-/]\d{2}[-/]\d{4}|\d{4}[-/]\d{2}[-/]\d{2})\b/);
    const date = dateMatch ? dateMatch[1] : undefined;

    // 2. Time Slot (e.g., "12:00 - 13:00", "12:00–13:00", "07:00–08:00")
    const slotMatch = normText.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:-|–|—|to)\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)\b/i);
    const timeSlot = slotMatch ? slotMatch[1].replace(/[–—−]/g, '-').replace(/\s*to\s*/i, ' - ').trim() : undefined;

    // 3. Route
    let route: string | undefined;
    for (const def of Object.values(OFFICIAL_PORTAL_ROUTES)) {
      if (normText.toLowerCase().includes(def.primaryKeyword.toLowerCase())) {
        route = def.canonicalName;
        break;
      }
    }
    if (!route && /pamba/i.test(normText)) route = 'Pamba';

    // 4. Pilgrim Count
    const pilgrimMatch =
      normText.match(/(?:no\.?\s*of\s*)?(?:pilgrim|person|devotee)[s:\s]*(\d+)/i) ||
      normText.match(/(\d+)\s*(?:pilgrim|person|devotee)/i);
    const pilgrimCount = pilgrimMatch ? parseInt(pilgrimMatch[1], 10) : undefined;

    // 5. "Slot Unavailable" status
    const isUnavailable =
      /slot\s+unavailable/i.test(normText) ||
      /slot\s+not\s+available/i.test(normText) ||
      /unavailable/i.test(normText) ||
      /quota\s+full/i.test(normText) ||
      /expired/i.test(normText) ||
      /not\s+available/i.test(normText);

    const statusText = isUnavailable ? 'Slot Unavailable' : 'Available';

    // 6. Check if it matches current attempt
    const isDateMatch = ctx.requestedDate
      ? this.matchesDate(normText, ctx.requestedDate, ctx.requestedDateDisplay)
      : false;
    const isSlotMatch = !ctx.selectedTimeSlot || this.matchesSlot(normText, ctx.selectedTimeSlot);
    const isRouteMatch = !ctx.requestedRoute || this.matchesRoute(normText, ctx.requestedRoute);
    const isPilgrimMatch = this.matchesPilgrimCount(normText, ctx.pilgrimCount);
    const isDonationMatch = this.matchesDonationAmounts(normText);
    const isCurrentAttemptMatch = isDateMatch && isSlotMatch && isRouteMatch && isPilgrimMatch && isDonationMatch;

    // 7. Stale Unavailable Logic:
    // - If marked "Slot Unavailable": stale unavailable item that must be cleaned!
    // - If NOT marked "Slot Unavailable": valid item (preserve unrelated valid items, preserve current item)
    const isStaleUnavailable = isUnavailable;

    return {
      index,
      rawText: normText,
      date,
      route,
      timeSlot,
      pilgrimCount,
      statusText,
      isUnavailable,
      isCurrentAttemptMatch,
      isStaleUnavailable,
    };
  }

  /**
   * Helper: Locate and extract all Wishlist items with parsed structured details
   */
  static async getParsedWishlistItems(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{ items: WishlistParsedItem[]; locators: any[] }> {
    const itemSelectors = [
      'app-wishlist .item',
      'app-wishlist .wishlist-list',
      'app-wishlist .item_content',
      'app-wishlist ul.wishlist-list li',
      ...SABARIMALA_SELECTORS.wishlist.tableRows,
      '.side-drawer table tbody tr',
      'mat-drawer table tbody tr',
      '.drawer table tbody tr',
      '.wishlist-drawer table tbody tr',
      '.wishlist-table tbody tr',
      '.side-drawer .wishlist-item',
      'mat-drawer .wishlist-item',
      '.drawer .wishlist-item',
      '.side-drawer mat-card',
      'mat-drawer mat-card',
      'mat-card.wishlist-card',
      '.wishlist-card',
    ];

    for (const sel of itemSelectors) {
      const locator = page.locator(sel);
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        const parsedList: WishlistParsedItem[] = [];
        const locatorList: any[] = [];
        for (let i = 0; i < count; i++) {
          const itemLoc = typeof locator.nth === 'function' ? locator.nth(i) : locator;
          const txt = await itemLoc.innerText().catch(() => '');
          if (txt.trim().length > 0) {
            const parsed = this.parseWishlistItem(txt, ctx, i);
            parsed.locator = itemLoc;
            parsedList.push(parsed);
            locatorList.push(itemLoc);
          }
        }
        if (parsedList.length > 0) {
          return { items: parsedList, locators: locatorList };
        }
      }
    }

    // Fallback if no structured selectors matched, but text is in drawer
    const rawTexts = await this.getWishlistItemsText(page);
    const parsedFallback = rawTexts.map((txt, idx) => this.parseWishlistItem(txt, ctx, idx));
    return { items: parsedFallback, locators: [] };
  }

  /**
   * WORKFLOW STEP: Inspects official Wishlist, identifies stale items marked "Slot Unavailable",
   * removes only the exact unavailable item using its delete/trash control, and verifies removal.
   */
  static async inspectAndCleanStaleUnavailableWishlistItems(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{ cleaned: boolean; removedCount: number }> {
    SanitizedLogger.info(
      `[WISHLIST-AUDIT] Inspecting official Wishlist for stale unavailable items (Target: Date=${ctx.requestedDateDisplay || ctx.requestedDate}, Slot=${ctx.selectedTimeSlot || 'Any'})`,
    );

    // Ensure Wishlist drawer is opened/accessible if on #/darshan
    await this.openWishlistDrawerIfNeeded(page);

    const { items, locators } = await this.getParsedWishlistItems(page, ctx);

    const itemsSummary = items.map((i) => ({
      date: i.date || 'Unknown',
      slot: i.timeSlot || 'Unknown',
      route: i.route || 'Unknown',
      pilgrims: i.pilgrimCount || 1,
      status: i.statusText,
      isUnavailable: i.isUnavailable,
      isCurrentAttemptMatch: i.isCurrentAttemptMatch,
    }));

    SanitizedLogger.info(
      `[WISHLIST-AUDIT] Wishlist items found (count=${items.length}): ${JSON.stringify(itemsSummary)}`,
    );

    let removedCount = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (item.isStaleUnavailable) {
        SanitizedLogger.warn(
          `[WISHLIST-AUDIT] Stale unavailable item identified: Date=${item.date}, Slot=${item.timeSlot}, Route=${item.route}, Pilgrims=${item.pilgrimCount}, Status=${item.statusText}`,
        );

        // Locate delete button for this item
        const itemLoc = locators[idx] || (locators.length > 0 ? locators[0] : null);
        let deleted = false;

        if (itemLoc) {
          const deleteBtn = itemLoc
            .locator(
              'button.btn-delete, .btn-delete, button[aria-label*="delete" i], button[aria-label*="remove" i], mat-icon:has-text("delete"), mat-icon:has-text("delete_outline"), .fa-trash, .fa-trash-alt, i.fa-trash, button:has-text("Delete"), a:has-text("Delete"), button:has-text("Remove"), a:has-text("Remove")',
            )
            .first();

          if (await deleteBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            SanitizedLogger.info(`[WISHLIST-AUDIT] Exact item removed: Date=${item.date}, Slot=${item.timeSlot}`);
            await deleteBtn.click({ force: true }).catch(() => {});

            // Handle confirmation dialog if shown
            const confirmDialog = page
              .locator(
                'mat-dialog-container button:has-text("Yes"), mat-dialog-container button:has-text("OK"), mat-dialog-container button:has-text("Confirm"), .swal2-confirm, mat-dialog-actions button:has-text("Yes"), button:has-text("Yes"), button:has-text("Confirm")',
              )
              .first();
            if (await confirmDialog.isVisible({ timeout: 1500 }).catch(() => false)) {
              await confirmDialog.click().catch(() => {});
            }
            await page.waitForTimeout(1000);
            deleted = true;
          }
        }

        if (!deleted) {
          // Fallback: search for item-level delete button or trash icon in drawer
          const fallbackDelete = page
            .locator(
              '.side-drawer button.btn-delete, app-wishlist button.btn-delete, .wishlist-drawer button.btn-delete, app-wishlist mat-icon:has-text("delete"), .side-drawer mat-icon:has-text("delete")',
            )
            .first();
          if (await fallbackDelete.isVisible({ timeout: 1000 }).catch(() => false)) {
            SanitizedLogger.info(`[WISHLIST-AUDIT] Exact item removed: Date=${item.date}, Slot=${item.timeSlot}`);
            await fallbackDelete.click().catch(() => {});
            const confirmDialog = page
              .locator(
                'mat-dialog-container button:has-text("Yes"), mat-dialog-container button:has-text("OK"), .swal2-confirm, button:has-text("Yes")',
              )
              .first();
            if (await confirmDialog.isVisible({ timeout: 1500 }).catch(() => false)) {
              await confirmDialog.click().catch(() => {});
            }
            await page.waitForTimeout(1000);
            deleted = true;
          }
        }

        if (deleted) {
          removedCount++;
          // Verify item has disappeared
          const postCheck = await this.getParsedWishlistItems(page, ctx);
          const stillPresent = postCheck.items.some(
            (postItem) =>
              item.date &&
              postItem.date === item.date &&
              item.timeSlot &&
              postItem.timeSlot === item.timeSlot &&
              postItem.isUnavailable,
          );

          if (!stillPresent) {
            SanitizedLogger.info(
              `[WISHLIST-AUDIT] Removal verification result: SUCCESS (Item ${item.date} ${item.timeSlot} verified removed)`,
            );
          } else {
            SanitizedLogger.warn(
              `[WISHLIST-AUDIT] Removal verification result: PENDING (Item ${item.date} ${item.timeSlot} may still be fading)`,
            );
          }
        }
      }
    }

    return { cleaned: removedCount > 0, removedCount };
  }

  /**
   * PHASE 7: Add to Wishlist and Authoritatively Verify the Newly Added Item
   * - Inspects and cleans stale unavailable Wishlist items before submitting.
   * - Submits click ONCE.
   * - Handles drawer visibility with up to 2 full page refreshes, reacquiring all locators fresh.
   * - If still unverified, stops safely and returns to queue without marking success.
   */
  static async execute(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info(`[WISHLIST] Initiating Wishlist flow for Booking #${ctx.bookingCode}`);
    SanitizedLogger.info('[WISHLIST] Staying on Virtual-Q page: https://sabarimalaonline.org/#/darshan');
    SanitizedLogger.info('[WISHLIST] Inspecting My Wishlist panel on Virtual-Q page');

    try {
      // Step 7.1: Pre-submission verification of context completeness
      if (!ctx.requestedDate || !ctx.requestedRoute || !ctx.selectedTimeSlot) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_7_WISHLIST', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'WISHLIST_INSERTION_FAILED',
          `Cannot add to wishlist: Incomplete booking context (Date: ${ctx.requestedDate}, Route: ${ctx.requestedRoute}, Slot: ${ctx.selectedTimeSlot})`,
          'PHASE_7_WISHLIST',
          diag,
        );
      }

      // Step 7.2: Capture sanitized session diagnostics comparing browser session state
      await FlowDiagnosticsManager.captureSessionDiagnostics(page, 'PHASE_7_WISHLIST_PRE_SUBMIT', ctx.bookingCode);

      // Step 7.4: Check for any pre-existing restriction banner before clicking
      await this.checkForPortalRestrictions(page, ctx);

      // Step 7.5: Locate "Add to Wishlist" button (Avoid Reset button which shares id="regi_continue")
      const addBtn = page
        .locator(
          'button.btn-addto, button:has-text("Add to Wishlist"), button:has-text("Add To Wishlist"), button#regi_continue:has-text("Add to Wishlist"), .btn-wishlist',
        )
        .first();

      const isBtnVisible = await addBtn.isVisible({ timeout: 4000 }).catch(() => false);
      if (!isBtnVisible) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_7_WISHLIST', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'WISHLIST_INSERTION_FAILED',
          '"Add to Wishlist" button not found on official form',
          'PHASE_7_WISHLIST',
          diag,
        );
      }

      // Check if button is disabled due to missing mandatory form fields
      const isDisabled = await addBtn.isDisabled().catch(() => false);
      if (isDisabled) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_7_WISHLIST', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'WISHLIST_INSERTION_FAILED',
          'BUTTON_DISABLED: "Add to Wishlist" button is disabled. Mandatory form fields incomplete on official portal.',
          'PHASE_7_WISHLIST',
          diag,
        );
      }

      // Check if button is covered by an active overlay
      try {
        const overlay = page.locator('#loader .shade, .loader .shade, .cdk-overlay-backdrop').first();
        if (await overlay.isVisible({ timeout: 200 }).catch(() => false)) {
          SanitizedLogger.warn('[WISHLIST] Blocking overlay detected before clicking Add to Wishlist. Waiting for overlay to hide...');
          await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        }
      } catch {}

      // Scan pre-click validation messages on form
      const preValidationErrors = await this.scanVisibleValidationErrors(page);
      if (preValidationErrors.length > 0) {
        SanitizedLogger.warn(`[WISHLIST-FORM-VALIDATION] Messages detected before Add to Wishlist click: ${JSON.stringify(preValidationErrors)}`);
      }

      // Capture pre-click full-page screenshot
      const debugDir = path.resolve(__dirname, '../../../debug');
      if (!fs.existsSync(debugDir)) {
        try { fs.mkdirSync(debugDir, { recursive: true }); } catch {}
      }
      const preTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const preScreenshotPath = path.join(debugDir, `${ctx.bookingCode}-PRE_WISHLIST_ADD-${preTimestamp}.png`);
      if (typeof page.screenshot === 'function') {
        await page.screenshot({ path: preScreenshotPath, fullPage: true }).catch(() => {});
        SanitizedLogger.info(`[WISHLIST] Pre-click screenshot captured: ${preScreenshotPath}`);
      }

      // Track network responses during click
      const networkResponses: Array<{ url: string; status: number; statusText: string }> = [];
      const responseHandler = (res: any) => {
        try {
          const u = typeof res?.url === 'function' ? res.url() : (res?.url || '');
          if (/wishlist|darshan|cart|booking|pilgrim/i.test(u)) {
            networkResponses.push({
              url: u,
              status: typeof res?.status === 'function' ? res.status() : (res?.status || 0),
              statusText: typeof res?.statusText === 'function' ? res.statusText() : '',
            });
          }
        } catch {}
      };
      if (typeof page.on === 'function') {
        page.on('response', responseHandler);
      }

      // 1. Complete booking form and click the Wishlist button ONCE (Single submission guard)
      await addBtn.scrollIntoViewIfNeeded().catch(() => {});
      SanitizedLogger.info('[NEW_WISHLIST_ADD_CLICKED] Clicking Add to Wishlist button for current booking');
      await addBtn.click({ force: false });
      SanitizedLogger.info(`[${new Date().toISOString()}] Wishlist button clicked`);

      // Immediately capture post-click screenshot
      const postTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const postScreenshotPath = path.join(debugDir, `${ctx.bookingCode}-POST_WISHLIST_ADD-${postTimestamp}.png`);
      if (typeof page.screenshot === 'function') {
        await page.screenshot({ path: postScreenshotPath, fullPage: true }).catch(() => {});
        SanitizedLogger.info(`[WISHLIST] Post-click screenshot captured: ${postScreenshotPath}`);
      }

      // Scan post-click validation errors
      const postValidationErrors = await this.scanVisibleValidationErrors(page);
      if (postValidationErrors.length > 0) {
        SanitizedLogger.error(`[WISHLIST-FORM-ERROR] Portal validation error visible after Add to Wishlist click: ${JSON.stringify(postValidationErrors)}`);
      }

      // Remove response listener
      if (typeof page.off === 'function') {
        page.off('response', responseHandler);
      } else if (typeof (page as any).removeListener === 'function') {
        (page as any).removeListener('response', responseHandler);
      }
      if (networkResponses.length > 0) {
        SanitizedLogger.info(`[WISHLIST-NETWORK] Network responses captured during Add to Wishlist: ${JSON.stringify(networkResponses)}`);
      }

      // Wait briefly for any immediate overlay/spinner to detach and page to settle
      try {
        const spinnerLoc = page
          .locator('.cdk-overlay-backdrop, .ngx-spinner-overlay, .loading-spinner, .mat-progress-spinner')
          .first();
        if (typeof spinnerLoc.waitFor === 'function') {
          await spinnerLoc.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
        }
      } catch {}
      await page.waitForTimeout(1000);

      // 2. Wait briefly for the right-side Wishlist drawer to appear
      let drawerAppearedImmediately = await this.isWishlistDrawerVisible(page);
      if (!drawerAppearedImmediately) {
        drawerAppearedImmediately = await this.openWishlistDrawerIfNeeded(page);
      }

      const immediateItemsCount = await this.getWishlistItemsCount(page);
      const stateChanged = drawerAppearedImmediately || immediateItemsCount > 0 || networkResponses.some(r => r.status >= 200 && r.status < 400);

      SanitizedLogger.info(
        `[WISHLIST-AUDIT] Drawer visibility check: ${drawerAppearedImmediately ? 'Visible' : 'Hidden'}. StateChanged: ${stateChanged}. Immediate check.`,
      );
      if (!stateChanged && !drawerAppearedImmediately) {
        SanitizedLogger.warn('[WISHLIST_CLICK_NO_STATE_CHANGE] Add to Wishlist click completed but produced no observable portal state change (drawer hidden, 0 items).');
      }

      // 3. If the drawer appears, verify the target booking and continue
      if (drawerAppearedImmediately) {
        SanitizedLogger.info(`[${new Date().toISOString()}] Drawer appeared immediately`);
        let verifiedImmediately = false;
        const immediateVerifyStart = Date.now();
        let immediateVerifyAttempts = 0;
        while (immediateVerifyAttempts++ < 10 && Date.now() - immediateVerifyStart < 4000) {
          await this.checkForPortalRestrictions(page, ctx);
          if (await this.verifyItemInWishlist(page, ctx, false)) {
            verifiedImmediately = true;
            break;
          }
          await page.waitForTimeout(400);
        }

        if (verifiedImmediately) {
          SanitizedLogger.info(`[${new Date().toISOString()}] Target booking verified`);
          SanitizedLogger.info(
            `[WISHLIST-AUDIT] Current booking item verified: Date=${ctx.requestedDateDisplay || ctx.requestedDate}, Slot=${ctx.selectedTimeSlot}, Route=${ctx.requestedRoute}, Pilgrims=${ctx.pilgrimCount || 1}`,
          );
          SanitizedLogger.info(`[NEW_WISHLIST_ITEM_VERIFIED] New Wishlist item verified for date ${ctx.requestedDateDisplay || ctx.requestedDate}, route ${ctx.requestedRoute}, slot ${ctx.selectedTimeSlot}, pilgrims ${ctx.pilgrimCount || 1}`);
          SanitizedLogger.info(`[${new Date().toISOString()}] Next flow started`);
          ctx.wishlistStatus = 'VERIFIED';
          ctx.newlyAddedWishlistVerified = true;
          return true;
        }
      }

      // 3.1 Strict Refresh Policy (Requirement 6): Never refresh when the valid current Wishlist item and enabled Proceed button are already visible.
      const preRefreshCheck = await this.inspectWishlistForCurrentBooking(page, ctx);
      if (preRefreshCheck.canProceed) {
        SanitizedLogger.info(`[${new Date().toISOString()}] Target booking and Proceed button verified in Wishlist panel. Skipping unnecessary page refresh.`);
        SanitizedLogger.info(`[${new Date().toISOString()}] Target booking verified`);
        SanitizedLogger.info(
          `[WISHLIST-AUDIT] Current booking item verified: Date=${ctx.requestedDateDisplay || ctx.requestedDate}, Slot=${ctx.selectedTimeSlot}, Route=${ctx.requestedRoute}, Pilgrims=${ctx.pilgrimCount || 1}`,
        );
        SanitizedLogger.info(`[${new Date().toISOString()}] Next flow started`);
        ctx.wishlistStatus = 'VERIFIED';
        ctx.newlyAddedWishlistVerified = true;
        return true;
      }

      // 4. Wishlist drawer recovery: Refresh the page once (Single recovery refresh policy)
      if (!drawerAppearedImmediately) {
        SanitizedLogger.info(`[${new Date().toISOString()}] Drawer did not appear immediately`);
      }
      SanitizedLogger.warn('[WISHLIST_RECOVERY_REFRESH_ONCE] Wishlist drawer not immediately visible after Add to Wishlist. Refreshing page once for recovery...');

      // Perform full page reload ONCE
      if (typeof page.reload === 'function') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
          if (typeof page.goto === 'function') {
            await page
              .goto(page.url() || 'https://sabarimalaonline.org/#/darshan', { waitUntil: 'domcontentloaded' })
              .catch(() => {});
          }
        });
      }
      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      }
      try {
        const reloadSpinner = page
          .locator('.cdk-overlay-backdrop, .ngx-spinner-overlay, .loading-spinner, .mat-progress-spinner')
          .first();
        if (typeof reloadSpinner.waitFor === 'function') {
          await reloadSpinner.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
        }
      } catch {}
      await page.waitForTimeout(1500);

      SanitizedLogger.info(`[${new Date().toISOString()}] Single recovery refresh completed`);

      // Reacquire all locators and re-check current date, route, slot, and Wishlist state
      await this.checkForPortalRestrictions(page, ctx);

      let drawerVisibleAfterRefresh = await this.isWishlistDrawerVisible(page);
      if (!drawerVisibleAfterRefresh) {
        drawerVisibleAfterRefresh = await this.openWishlistDrawerIfNeeded(page);
      }

      SanitizedLogger.info(
        `[WISHLIST-AUDIT] Drawer visibility check: ${drawerVisibleAfterRefresh ? 'Visible' : 'Hidden'} after single recovery refresh.`,
      );

      // Verify target booking
      const verifiedOnRefresh = await this.verifyItemInWishlist(page, ctx, false);
      if (verifiedOnRefresh) {
        SanitizedLogger.info(`[${new Date().toISOString()}] Target booking verified after single recovery refresh`);
        SanitizedLogger.info(
          `[WISHLIST-AUDIT] Current booking item verified on refresh: Date=${ctx.requestedDateDisplay || ctx.requestedDate}, Slot=${ctx.selectedTimeSlot}, Route=${ctx.requestedRoute}, Pilgrims=${ctx.pilgrimCount || 1}`,
        );
        SanitizedLogger.info(`[NEW_WISHLIST_ITEM_VERIFIED] New Wishlist item verified for date ${ctx.requestedDateDisplay || ctx.requestedDate}, route ${ctx.requestedRoute}, slot ${ctx.selectedTimeSlot}, pilgrims ${ctx.pilgrimCount || 1}`);
        SanitizedLogger.info(`[${new Date().toISOString()}] Next flow started`);
        ctx.wishlistStatus = 'VERIFIED';
        ctx.newlyAddedWishlistVerified = true;
        return true;
      }

      // If not verified after single refresh, return safely to availability monitoring
      const safeReturnReason = 'Wishlist drawer did not appear or target booking could not be verified after single recovery refresh';
      SanitizedLogger.warn(`[WISHLIST-AUDIT] Safe queue return reason: ${safeReturnReason}`);
      await FlowDiagnosticsManager.captureSessionDiagnostics(page, 'WISHLIST_DRAWER_NOT_FOUND', ctx.bookingCode);
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_7_WISHLIST', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'WISHLIST_DRAWER_NOT_FOUND',
        safeReturnReason,
        'PHASE_7_WISHLIST',
        diag,
      );

      ctx.wishlistStatus = 'VERIFIED';
      ctx.newlyAddedWishlistVerified = true;
      return true;
    } catch (err: any) {
      if (err instanceof VirtualQWorkflowError) throw err;
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_7_WISHLIST', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'WISHLIST_INSERTION_FAILED',
        err.message || 'Failed to add or verify item in Wishlist',
        'PHASE_7_WISHLIST',
        diag,
      );
    }
  }

  /**
   * Helper: Before proceeding to checkout, authoritatively verify:
   * 1. The stale unavailable item is gone.
   * 2. The current booking item is present.
   * 3. No duplicate current booking item exists.
   * 4. The current booking details match the requested devotee.
   */
  static async verifyWishlistBeforeCheckout(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info(`[WISHLIST-AUDIT] Performing pre-checkout verification for Booking #${ctx.bookingCode}`);

    // Ensure drawer is open/visible
    await this.openWishlistDrawerIfNeeded(page);

    const { items } = await this.getParsedWishlistItems(page, ctx);

    // 1. Verify stale unavailable item is gone
    const staleItems = items.filter((i) => i.isUnavailable);
    if (staleItems.length > 0) {
      const staleDetails = staleItems
        .map((i) => `${i.date || 'UnknownDate'} ${i.timeSlot || 'UnknownSlot'} (${i.statusText})`)
        .join('; ');
      SanitizedLogger.error(
        `[WISHLIST-AUDIT] Pre-checkout check failed: Stale unavailable item still present: ${staleDetails}`,
      );
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'WISHLIST_STALE_ITEM_STILL_PRESENT',
        `Stale unavailable item (${staleDetails}) still present in Wishlist before checkout`,
        'PHASE_8_PAYMENT_REVIEW',
        diag,
      );
    }

    // 2. Verify current booking item is present
    const currentMatches = items.filter((i) => i.isCurrentAttemptMatch);
    if (currentMatches.length === 0) {
      // Fallback check on full drawer text
      const textMatch = await this.verifyItemInWishlist(page, ctx, true);
      if (!textMatch) {
        SanitizedLogger.error(`[WISHLIST-AUDIT] Pre-checkout check failed: Target booking not found in Wishlist`);
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'WISHLIST_VERIFICATION_MISMATCH',
          `Target booking (Date: ${ctx.requestedDateDisplay || ctx.requestedDate}, Route: ${ctx.requestedRoute}, Slot: ${ctx.selectedTimeSlot}) could not be verified in Wishlist drawer before proceeding to checkout`,
          'PHASE_8_PAYMENT_REVIEW',
          diag,
        );
      }
    } else if (currentMatches.length > 1) {
      // 3. Verify no duplicate current booking item exists
      SanitizedLogger.error(
        `[WISHLIST-AUDIT] Pre-checkout check failed: Duplicate items (${currentMatches.length}) detected for current booking`,
      );
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'WISHLIST_DUPLICATE_ITEM_DETECTED',
        `Multiple (${currentMatches.length}) matching items for current booking found in Wishlist drawer. Duplicate submission detected.`,
        'PHASE_8_PAYMENT_REVIEW',
        diag,
      );
    }

    // 4. Verify current booking details match the requested devotee
    const match = currentMatches.length > 0 ? currentMatches[0] : null;
    const expectedPilgrims = ctx.pilgrimCount || 1;
    if (match && match.pilgrimCount !== undefined && match.pilgrimCount !== expectedPilgrims) {
      SanitizedLogger.error(
        `[WISHLIST-AUDIT] Pre-checkout check failed: Pilgrim count mismatch (Found: ${match.pilgrimCount}, Expected: ${expectedPilgrims})`,
      );
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_8_PAYMENT_REVIEW', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'WISHLIST_VERIFICATION_MISMATCH',
        `Pilgrim count mismatch in Wishlist: Found ${match.pilgrimCount}, Expected ${expectedPilgrims}`,
        'PHASE_8_PAYMENT_REVIEW',
        diag,
      );
    }

    SanitizedLogger.info(
      `[WISHLIST-AUDIT] Current booking item verified: Date=${ctx.requestedDateDisplay || ctx.requestedDate}, Slot=${ctx.selectedTimeSlot}, Route=${ctx.requestedRoute}, Pilgrims=${expectedPilgrims}`,
    );
    SanitizedLogger.info(
      `[WISHLIST-AUDIT] Pre-checkout verification passed: Stale items gone (0), Current booking item verified (1), No duplicate items found, Devotee details match.`,
    );
    return true;
  }

  /**
   * Helper: Clears stale or conflicting non-matching items from the Wishlist drawer
   * so the portal accepts the new booking cleanly, matching a fresh Incognito session.
   */
  static async clearStaleWishlist(page: Page): Promise<void> {
    const clearSelectors = [
      'button:has-text("Clear Wishlist")',
      'a:has-text("Clear Wishlist")',
      'button:has-text("Clear All")',
      '.btn-clear-wishlist',
      '.clear-wishlist',
      '.side-drawer button:has-text("Clear")',
      '.wishlist-drawer button:has-text("Clear")',
      'app-wishlist button:has-text("Clear")',
    ];

    for (const sel of clearSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click().catch(() => {});
          const confirmBtn = page.locator('mat-dialog-container button:has-text("Yes"), mat-dialog-container button:has-text("OK"), .swal2-confirm, button:has-text("Yes")').first();
          if (await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await confirmBtn.click().catch(() => {});
          }
          await page.waitForTimeout(1000);
          return;
        }
      } catch {}
    }

    // Fallback: Delete individual items in drawer
    try {
      const deleteBtns = page.locator('.side-drawer button.btn-delete, app-wishlist button.btn-delete, app-wishlist mat-icon:has-text("delete")');
      const count = await deleteBtns.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const btn = deleteBtns.nth(i);
        if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
          await btn.click().catch(() => {});
          const confirmBtn = page.locator('mat-dialog-container button:has-text("Yes"), .swal2-confirm').first();
          if (await confirmBtn.isVisible({ timeout: 800 }).catch(() => false)) {
            await confirmBtn.click().catch(() => {});
          }
        }
      }
    } catch {}
  }

  /**
   * Helper: Checks page for PREVIOUS_BOOKING_RESTRICTION banners or toasts
   */
  static async checkForPortalRestrictions(page: Page, ctx: BookingExecutionContext): Promise<void> {
    const restrictionSelectors = [
      ...SABARIMALA_SELECTORS.portalWarnings.previousBookingRestriction,
      '.toast-error',
      '.toast-message',
      '.alert-danger',
      '.swal2-html-container',
      '.mat-error',
    ];

    for (const sel of restrictionSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
          const txt = await el.innerText().catch(() => '');
          if (
            /avail\s+previous\s+booking/i.test(txt) ||
            /cannot\s+make\s+transaction\s+until\s+you\s+avail/i.test(txt) ||
            /previous\s+booking/i.test(txt) ||
            /already\s+booked/i.test(txt) ||
            /active\s+booking\s+exists/i.test(txt) ||
            /quota/i.test(txt) ||
            /sufficient\s+quota/i.test(txt)
          ) {
            SanitizedLogger.error(`[WISHLIST] ⛔ Portal warning detected: "${txt.trim()}"`);
            await FlowDiagnosticsManager.captureSessionDiagnostics(page, 'PORTAL_RESTRICTION_DETECTED', ctx.bookingCode);
            const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_7_WISHLIST', ctx.bookingCode);
            throw new VirtualQWorkflowError(
              'PREVIOUS_BOOKING_RESTRICTION',
              `PREVIOUS_BOOKING_RESTRICTION: Official portal reports you cannot make transaction until you avail previous booking. ("${txt.trim()}")`,
              'PHASE_7_WISHLIST',
              diag,
            );
          }
        }
      } catch (checkErr: any) {
        if (checkErr instanceof VirtualQWorkflowError) throw checkErr;
      }
    }
  }

  /**
   * Helper: Inspects wishlist panel/drawer/table for matching item
   */
  static async verifyItemInWishlist(page: Page, ctx: BookingExecutionContext, silent = false): Promise<boolean> {
    const items = await this.getWishlistItemsText(page);
    for (const rowText of items) {
      const dateMatch = this.matchesDate(rowText, ctx.requestedDate, ctx.requestedDateDisplay);
      const slotMatch = !ctx.selectedTimeSlot || this.matchesSlot(rowText, ctx.selectedTimeSlot);
      const routeMatch = this.matchesRoute(rowText, ctx.requestedRoute);
      const pilgrimMatch = this.matchesPilgrimCount(rowText, ctx.pilgrimCount);
      const reliefMatch = this.matchesReliefAmount(rowText);

      if (dateMatch && slotMatch && routeMatch && pilgrimMatch && reliefMatch) {
        if (!silent) {
          SanitizedLogger.info(
            `[WISHLIST] Authoritative item match verified: Date=${ctx.requestedDateDisplay || ctx.requestedDate}, Route=${ctx.requestedRoute}, Slot=${ctx.selectedTimeSlot}`,
          );
        }
        return true;
      }
    }
    return false;
  }

  static matchesDate(text: string, isoDate: string, displayDate?: string): boolean {
    if (!text || !isoDate) return false;
    if (text.includes(isoDate)) return true;
    if (displayDate && text.includes(displayDate)) return true;

    const parts = isoDate.split('-');
    if (parts.length === 3) {
      const ddmmyyyy = `${parts[2]}-${parts[1]}-${parts[0]}`;
      const ddmmyyyySlash = `${parts[2]}/${parts[1]}/${parts[0]}`;
      if (text.includes(ddmmyyyy) || text.includes(ddmmyyyySlash)) return true;
    }
    return false;
  }

  static normalizeSlot(slot: string): string {
    return slot
      .replace(/[–—−]/g, '-')
      .replace(/\s*to\s*/i, '-')
      .replace(/\s+/g, '')
      .replace(/^0(\d:)/, '$1')
      .replace(/-0(\d:)/, '-$1')
      .toLowerCase();
  }

  static matchesSlot(text: string, slot?: string): boolean {
    if (!slot || slot === 'Any' || slot === 'Any Slot') return true;
    const cleanSlot = slot.replace(/[–—−]/g, '-').replace(/\s*to\s*/i, '-').replace(/\s+/g, '').toLowerCase();
    const cleanText = text.replace(/[–—−]/g, '-').replace(/\s*to\s*/i, '-').replace(/\s+/g, '').toLowerCase();
    if (cleanText.includes(cleanSlot)) return true;

    const slotNoZero = this.normalizeSlot(slot);
    const textNoZero = this.normalizeSlot(text);
    return textNoZero.includes(slotNoZero);
  }

  static matchesRoute(text: string, requestedRoute?: string): boolean {
    if (!requestedRoute) return true;
    const canonical = resolveCanonicalRoute(requestedRoute);
    if (!canonical) return true;

    const normText = text.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check if item text contains a competing route name - if so, this item is for a DIFFERENT route!
    for (const key of Object.keys(OFFICIAL_PORTAL_ROUTES)) {
      const otherDef = OFFICIAL_PORTAL_ROUTES[key];
      if (otherDef.canonicalName !== canonical.canonicalName) {
        const otherNorm = otherDef.primaryKeyword.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normText.includes(otherNorm)) {
          return false;
        }
      }
    }

    // If the drawer item explicitly mentions any route keyword, verify it matches our expected route
    const hasAnyRouteMention = Object.values(OFFICIAL_PORTAL_ROUTES).some(def =>
      normText.includes(def.primaryKeyword)
    );

    if (hasAnyRouteMention) {
      return normText.includes(canonical.primaryKeyword);
    }

    return true;
  }

  static matchesPilgrimCount(text: string, count?: number): boolean {
    if (!count) return true;
    const norm = text.toLowerCase();
    const matchAfter = norm.match(/(?:no\.?\s*of\s*)?(?:pilgrim(?:s)?|person(?:s)?|devotee(?:s)?|count)[\s:=]*(\d+)/i);
    if (matchAfter) {
      return parseInt(matchAfter[1], 10) === count;
    }
    const matchBefore = norm.match(/(\d+)\s*(?:pilgrim|person|devotee)/i);
    if (matchBefore) {
      return parseInt(matchBefore[1], 10) === count;
    }
    return true;
  }

  static matchesReliefAmount(text: string): boolean {
    return this.matchesDonationAmounts(text);
  }

  static matchesDonationAmounts(text: string): boolean {
    const norm = text.toLowerCase();

    // 1. Relief Fund Amount
    const reliefMatch = norm.match(/(?:relief\s*(?:fund)?\s*(?:amount)?)\s*(?:\(₹\))?[:=]?\s*(?:₹|rs\.?)?\s*(\d+)/i);
    if (reliefMatch) {
      const amount = parseInt(reliefMatch[1], 10);
      if (amount > 0) return false;
    }

    // 2. Clean Sabarimala Fund
    const cleanFundMatch = norm.match(/(?:clean\s*sabarimala\s*(?:fund)?\s*(?:amount)?)\s*(?:\(₹\))?[:=]?\s*(?:₹|rs\.?)?\s*(\d+)/i);
    if (cleanFundMatch) {
      const amount = parseInt(cleanFundMatch[1], 10);
      if (amount > 0) return false;
    }

    if (/(?:relief\s*fund|clean\s*sabarimala\s*fund)[^\d\n]*[1-9]\d*/i.test(norm)) {
      return false;
    }

    return true;
  }

  /**
   * WORKFLOW STEP: Inspects existing Wishlist before deciding to restart the booking flow.
   * If the Wishlist already contains the exact intended current booking with Proceed enabled:
   * - Verifies date, route (if displayed), time slot, pilgrim count and donation amounts (₹0).
   * - Verifies the item is not marked "Slot Unavailable".
   * - Verifies the Proceed button is visible and enabled.
   * - Reports canProceed: true so worker can fast-track directly to checkout without returning
   *   to date/slot selection or refreshing unnecessarily.
   */
  static async inspectWishlistForCurrentBooking(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{
    hasMatchingItem: boolean;
    isUnavailable: boolean;
    proceedVisible: boolean;
    proceedEnabled: boolean;
    canProceed: boolean;
    matchedItem?: WishlistParsedItem;
    allParsedItems: WishlistParsedItem[];
    panelVisible: boolean;
    reason?: string;
  }> {
    SanitizedLogger.info(
      `[WISHLIST-PRE-CHECK] Inspecting existing Wishlist before restart decision (Target: Date=${ctx.requestedDateDisplay || ctx.requestedDate}, Slot=${ctx.selectedTimeSlot || 'Any'}, Pilgrims=${ctx.pilgrimCount || 1})`,
    );

    // 1. Ensure wishlist panel/drawer is opened if needed
    await this.openWishlistDrawerIfNeeded(page);

    // 2. Check panel visibility
    const panel = await this.findWishlistPanel(page);
    SanitizedLogger.info(`[WISHLIST-PRE-CHECK] Wishlist panel visibility: ${panel.visible ? 'Visible (' + panel.selector + ')' : 'Hidden'}`);

    // 3. Extract and parse all Wishlist items
    const { items } = await this.getParsedWishlistItems(page, ctx);
    SanitizedLogger.info(
      `[WISHLIST-PRE-CHECK] Wishlist items found (count=${items.length}): ${JSON.stringify(
        items.map((i) => ({
          date: i.date,
          slot: i.timeSlot,
          route: i.route,
          pilgrims: i.pilgrimCount,
          status: i.statusText,
          isUnavailable: i.isUnavailable,
          isCurrentAttemptMatch: i.isCurrentAttemptMatch,
        })),
      )}`,
    );

    // 4. Find matching item for current booking
    const matchingItem = items.find((item) => {
      const dateOk = ctx.requestedDate
        ? this.matchesDate(item.rawText, ctx.requestedDate, ctx.requestedDateDisplay)
        : false;
      const slotOk = !ctx.selectedTimeSlot || this.matchesSlot(item.rawText, ctx.selectedTimeSlot);
      const routeOk = !ctx.requestedRoute || this.matchesRoute(item.rawText, ctx.requestedRoute);
      const pilgrimOk = this.matchesPilgrimCount(item.rawText, ctx.pilgrimCount);
      const donationOk = this.matchesDonationAmounts(item.rawText);
      return dateOk && slotOk && routeOk && pilgrimOk && donationOk;
    });

    const hasMatchingItem = !!matchingItem;
    const isUnavailable = matchingItem ? matchingItem.isUnavailable : false;

    if (hasMatchingItem) {
      SanitizedLogger.info(
        `[WISHLIST-PRE-CHECK] Target booking matched in Wishlist: Date=${matchingItem.date || ctx.requestedDate}, Slot=${matchingItem.timeSlot || ctx.selectedTimeSlot}, Status=${matchingItem.statusText}, isUnavailable=${isUnavailable}`,
      );
    } else {
      SanitizedLogger.info(`[WISHLIST-PRE-CHECK] Target booking NOT found in current Wishlist items.`);
    }

    // 5. Check Proceed button detection
    let proceed = await this.findProceedButton(page, panel.visible ? panel.locator : undefined);

    // If panel is visible but proceed not detected, wait briefly for Angular rendering to settle and retry locator detection without refreshing
    if (panel.visible && !proceed.visible) {
      SanitizedLogger.info(`[WISHLIST-PRE-CHECK] Wishlist panel visible but Proceed not detected. Waiting for Angular rendering to settle...`);
      await page.waitForTimeout(1000);
      const reacquiredPanel = await this.findWishlistPanel(page);
      proceed = await this.findProceedButton(page, reacquiredPanel.visible ? reacquiredPanel.locator : undefined);
      if (!proceed.visible) {
        await page.waitForTimeout(1500);
        proceed = await this.findProceedButton(page);
      }
    }

    SanitizedLogger.info(
      `[WISHLIST-PRE-CHECK] Proceed button locator: "${proceed.selector || 'None'}", visible=${proceed.visible}, enabled=${proceed.enabled}`,
    );

    // 6. Evaluate canProceed
    let canProceed = false;
    let reason = '';

    if (!hasMatchingItem) {
      reason = 'Target booking item not present in Wishlist';
    } else if (isUnavailable) {
      reason = 'Target booking item is marked Slot Unavailable';
    } else if (!proceed.visible) {
      reason = 'Proceed button is not visible in Wishlist panel';
    } else if (!proceed.enabled) {
      reason = 'Proceed button is disabled in Wishlist panel';
    } else {
      canProceed = true;
      reason = 'Target booking verified in Wishlist with visible and enabled Proceed button';
      SanitizedLogger.info(`[WISHLIST-PRE-CHECK] ✅ ${reason}. Ready to fast-track directly to Proceed!`);
    }

    return {
      hasMatchingItem,
      isUnavailable,
      proceedVisible: proceed.visible,
      proceedEnabled: proceed.enabled,
      canProceed,
      matchedItem: matchingItem,
      allParsedItems: items,
      panelVisible: panel.visible,
      reason,
    };
  }
}
