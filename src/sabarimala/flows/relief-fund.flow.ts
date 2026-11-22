import { Page, Locator } from 'playwright';
import { SanitizedLogger } from '../../monitoring/logger';
import { BookingExecutionContext, VirtualQWorkflowError } from './types';
import { FlowDiagnosticsManager } from './diagnostics';

export class ReliefFundFlow {
  /**
   * Helper to evaluate whether an element or radio button is checked.
   */
  private static async isElementChecked(locator: Locator): Promise<boolean> {
    return await locator.evaluate((el: HTMLElement) => {
      if (el instanceof HTMLInputElement) return el.checked;
      return (
        el.classList.contains('mat-radio-checked') ||
        !!el.querySelector('.mat-radio-checked') ||
        el.getAttribute('aria-checked') === 'true'
      );
    }).catch(() => false);
  }

  /**
   * Helper to extract positive numerical amount from text or input value.
   */
  public static extractAmount(text: string): number {
    if (!text) return 0;
    // Look for currency symbol ₹ or Rs followed by digits
    const currencyMatch = text.match(/(?:₹|Rs\.?)\s*(\d+(?:\.\d+)?)/i);
    if (currencyMatch && currencyMatch[1]) {
      const parsed = parseFloat(currencyMatch[1]);
      if (!isNaN(parsed)) return parsed;
    }
    // Look for keywords Total / Amount / Fee / Contribution followed by digits
    const keywordMatch = text.match(/(?:total|amount|contribution|fee|payable)[^\d]*(\d+(?:\.\d+)?)/i);
    if (keywordMatch && keywordMatch[1]) {
      const parsed = parseFloat(keywordMatch[1]);
      if (!isNaN(parsed)) return parsed;
    }
    return 0;
  }

  /**
   * Scans the page for any displayed Total Amount > 0.
   */
  public static async scanTotalAmount(page: Page): Promise<number> {
    const amountSelectors = [
      '.total-amount',
      '#totalAmount',
      '#total_amount',
      '.total-fee',
      '.fee-amount',
      '.grand-total',
      '.total-contribution',
      '.clean-amount',
      '.clean-sabarimala-amount',
      '.relief-amount',
      '.fund-amount',
      'input[name*="amount" i]',
      'input[name*="total" i]',
      'input[formcontrolname*="amount" i]',
      'input[formcontrolname*="total" i]',
    ];

    for (const sel of amountSelectors) {
      const loc = page.locator(sel);
      if (typeof loc?.count === 'function') {
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const item = loc.nth(i);
          if (await item.isVisible({ timeout: 150 }).catch(() => false)) {
            const val = await item.inputValue().catch(() => '');
            if (val) {
              const num = parseFloat(val.replace(/[^\d.]/g, ''));
              if (!isNaN(num) && num > 0) return num;
            }
            const text = await item.innerText().catch(() => '');
            if (text) {
              const num = this.extractAmount(text);
              if (num > 0) return num;
            }
          }
        }
      } else if (typeof loc?.first === 'function') {
        const item = loc.first();
        if (await item.isVisible({ timeout: 150 }).catch(() => false)) {
          const val = typeof item.inputValue === 'function' ? await item.inputValue().catch(() => '') : '';
          if (val) {
            const num = parseFloat(val.replace(/[^\d.]/g, ''));
            if (!isNaN(num) && num > 0) return num;
          }
          const text = typeof item.innerText === 'function' ? await item.innerText().catch(() => '') : '';
          if (text) {
            const num = this.extractAmount(text);
            if (num > 0) return num;
          }
        }
      }
    }

    const textPatterns = [
      'text=/Total Amount/i',
      'text=/Total Contribution/i',
      'text=/Contribution to Clean Sabarimala.*₹/i',
      'text=/Clean Sabarimala.*₹/i',
      'text=/Relief Fund.*₹/i',
    ];

    for (const pattern of textPatterns) {
      const loc = page.locator(pattern);
      if (typeof loc?.count === 'function') {
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const item = loc.nth(i);
          if (await item.isVisible({ timeout: 150 }).catch(() => false)) {
            const text = await item.innerText().catch(() => '');
            const num = this.extractAmount(text);
            if (num > 0) return num;
          }
        }
      } else if (typeof loc?.first === 'function') {
        const item = loc.first();
        if (await item.isVisible({ timeout: 150 }).catch(() => false)) {
          const text = typeof item.innerText === 'function' ? await item.innerText().catch(() => '') : '';
          const num = this.extractAmount(text);
          if (num > 0) return num;
        }
      }
    }

    return 0;
  }

  /**
   * Opts out of Pilgrim Relief Fund (Section 1).
   */
  private static async handlePilgrimReliefFund(page: Page, ctx: BookingExecutionContext): Promise<void> {
    SanitizedLogger.info('[RELIEF-FUND] Setting "Contribute for Pilgrim Relief fund" to NO (Amount = ₹0)');

    const noSelectors = [
      'mat-radio-group[name="contribute"] mat-radio-button[value="no"]',
      'mat-radio-group[name="contribute"] mat-radio-button:has-text("No")',
      'mat-radio-group[formcontrolname="contribute"] mat-radio-button:has-text("No")',
      'mat-radio-group[name*="relief" i] mat-radio-button:has-text("No")',
      'mat-radio-group[name="contribute"] label:has-text("No")',
      'mat-radio-button[value="no"]',
      'input[type="radio"][value="No"]',
      'input[type="radio"][value="no"]',
      'input[type="radio"][value="N"]',
      'mat-radio-button:has-text("No")',
      'label:has-text("No")',
    ];

    let noBtn: Locator | null = null;
    for (const sel of noSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        noBtn = el;
        break;
      }
    }

    if (!noBtn) {
      const labelNo = page.getByLabel(/^No$/i).first();
      if (await labelNo.isVisible({ timeout: 500 }).catch(() => false)) {
        noBtn = labelNo;
      }
    }

    if (!noBtn) {
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'RELIEF_FUND_SELECTION_FAILED',
        'Pilgrim Relief Fund "No" radio control not found on official form',
        'PHASE_6_RELIEF_FUND',
        diag,
      );
    }

    // Click "No"
    await noBtn.scrollIntoViewIfNeeded().catch(() => {});
    await noBtn.click({ force: false }).catch(async () => {
      await noBtn.check().catch(() => {});
    });
    await noBtn.evaluate((el: HTMLElement) => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }).catch(() => {});
    await page.waitForTimeout(600);

    // Verify "No" is actively checked
    const isNoChecked = await this.isElementChecked(noBtn);
    if (!isNoChecked) {
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'RELIEF_FUND_SELECTION_FAILED',
        'RELIEF_FUND_UNVERIFIED: Relief Fund "No" radio button could not be verified as selected',
        'PHASE_6_RELIEF_FUND',
        diag,
      );
    }

    // Verify "Yes" is NOT checked
    const yesSelectors = [
      'mat-radio-group[name="contribute"] mat-radio-button[value="yes"]',
      'mat-radio-group[name="contribute"] mat-radio-button:has-text("Yes")',
      'mat-radio-group[formcontrolname="contribute"] mat-radio-button:has-text("Yes")',
      'mat-radio-group[name*="relief" i] mat-radio-button:has-text("Yes")',
      'input[type="radio"][value="Yes"]',
      'input[type="radio"][value="yes"]',
      'mat-radio-button:has-text("Yes")',
    ];

    let yesRadio: Locator | null = null;
    for (const sel of yesSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
        yesRadio = el;
        break;
      }
    }

    if (yesRadio) {
      const isYesChecked = await this.isElementChecked(yesRadio);
      if (isYesChecked) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'RELIEF_FUND_SELECTION_FAILED',
          'Relief Fund "Yes" radio is unexpectedly checked. Unintended contribution detected.',
          'PHASE_6_RELIEF_FUND',
          diag,
        );
      }
    }

    // Verify displayed relief amount is ₹0 where portal displays it
    const amountSelectors = [
      'mat-radio-group[name="contribute"] .relief-amount',
      'mat-radio-group[name="contribute"] .fund-amount',
      '.relief-amount',
      '.fund-amount',
      'text=/Relief Fund Amount/i',
    ];

    let displayedAmount: Locator | null = null;
    for (const sel of amountSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
        displayedAmount = el;
        break;
      }
    }

    if (displayedAmount) {
      const txt = typeof displayedAmount.innerText === 'function' ? await displayedAmount.innerText().catch(() => '') : '';
      if (txt.includes('₹') && !txt.includes('0')) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'RELIEF_FUND_SELECTION_FAILED',
          `Relief fund amount displays non-zero: "${txt}"`,
          'PHASE_6_RELIEF_FUND',
          diag,
        );
      }
    }

    SanitizedLogger.info('[RELIEF-FUND] Opted out of Pilgrim Relief Fund (Amount = ₹0)');
  }

  /**
   * Opts out of Clean Sabarimala Project (Section 2).
   */
  private static async handleCleanSabarimala(page: Page, ctx: BookingExecutionContext): Promise<void> {
    SanitizedLogger.info('[CLEAN-SABARIMALA] Checking for "Contribution to Clean Sabarimala Project (Optional)"');

    // 1. Direct radio selectors for Clean Sabarimala "No"
    const cleanNoSelectors = [
      'mat-radio-group[name*="clean" i] mat-radio-button[value="no" i]',
      'mat-radio-group[name*="clean" i] mat-radio-button:has-text("No")',
      'mat-radio-group[formcontrolname*="clean" i] mat-radio-button[value="no" i]',
      'mat-radio-group[formcontrolname*="clean" i] mat-radio-button:has-text("No")',
      'mat-card:has-text("Clean Sabarimala") mat-radio-button:has-text("No")',
      'div:has-text("Clean Sabarimala") mat-radio-button:has-text("No")',
      'input[name*="clean" i][value="no" i]',
      'input[name*="clean" i][value="No"]',
    ];

    let cleanNoBtn: Locator | null = null;
    for (const sel of cleanNoSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        cleanNoBtn = el;
        break;
      }
    }

    if (cleanNoBtn) {
      SanitizedLogger.info('[CLEAN-SABARIMALA] Setting "Contribution to Clean Sabarimala Project" to NO (Amount = ₹0)');
      await cleanNoBtn.scrollIntoViewIfNeeded().catch(() => {});
      await cleanNoBtn.click({ force: false }).catch(async () => {
        await cleanNoBtn.check().catch(() => {});
      });
      await cleanNoBtn.evaluate((el: HTMLElement) => {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }).catch(() => {});
      await page.waitForTimeout(600);

      // Verify Clean Sabarimala "No" is checked
      const isCleanNoChecked = await this.isElementChecked(cleanNoBtn);
      if (!isCleanNoChecked) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'RELIEF_FUND_SELECTION_FAILED',
          'Clean Sabarimala Project "No" radio button could not be verified as selected',
          'PHASE_6_RELIEF_FUND',
          diag,
        );
      }

      // Verify "Yes" is NOT checked for Clean Sabarimala
      const cleanYesSelectors = [
        'mat-radio-group[name*="clean" i] mat-radio-button[value="yes" i]',
        'mat-radio-group[name*="clean" i] mat-radio-button:has-text("Yes")',
        'mat-radio-group[formcontrolname*="clean" i] mat-radio-button[value="yes" i]',
        'mat-radio-group[formcontrolname*="clean" i] mat-radio-button:has-text("Yes")',
        'mat-card:has-text("Clean Sabarimala") mat-radio-button:has-text("Yes")',
        'div:has-text("Clean Sabarimala") mat-radio-button:has-text("Yes")',
        'input[name*="clean" i][value="yes" i]',
        'input[name*="clean" i][value="Yes"]',
      ];

      let cleanYesRadio: Locator | null = null;
      for (const sel of cleanYesSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
          cleanYesRadio = el;
          break;
        }
      }

      if (cleanYesRadio) {
        const isYesChecked = await this.isElementChecked(cleanYesRadio);
        if (isYesChecked) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'RELIEF_FUND_SELECTION_FAILED',
            'Clean Sabarimala Project "Yes" radio is unexpectedly checked. Unintended contribution detected.',
            'PHASE_6_RELIEF_FUND',
            diag,
          );
        }
      }

      // Verify clean sabarimala amount resets to ₹0
      const cleanAmountSelectors = [
        'mat-radio-group[name*="clean" i] .clean-amount',
        'mat-card:has-text("Clean Sabarimala") .amount',
        '.clean-sabarimala-amount',
        'text=/Clean Sabarimala.*₹/i',
      ];
      let cleanAmountLoc: Locator | null = null;
      for (const sel of cleanAmountSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
          cleanAmountLoc = el;
          break;
        }
      }

      if (cleanAmountLoc) {
        const txt = typeof cleanAmountLoc.innerText === 'function' ? await cleanAmountLoc.innerText().catch(() => '') : '';
        if (txt.includes('₹') && !txt.includes('0')) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'RELIEF_FUND_SELECTION_FAILED',
            `Clean Sabarimala amount displays non-zero: "${txt}"`,
            'PHASE_6_RELIEF_FUND',
            diag,
          );
        }
      }

      SanitizedLogger.info('[CLEAN-SABARIMALA] Opted out of Clean Sabarimala Project (Amount = ₹0)');
    } else {
      SanitizedLogger.info('[CLEAN-SABARIMALA] Clean Sabarimala prompt not present on this page view.');
    }
  }

  /**
   * The "Fail-Safe" Safety Net:
   * Scans the page for any Total Amount > 0.
   * If > 0:
   * 1. Logs [ERROR] stating "Unwanted donation detected. Total amount is > 0."
   * 2. Searches for any currently unchecked "No" radio buttons and clicks them.
   * 3. Re-checks amount. If STILL > 0, aborts the booking and fails the job.
   */
  private static async enforceZeroDonationFailSafe(page: Page, ctx: BookingExecutionContext): Promise<void> {
    let currentAmount = await this.scanTotalAmount(page);

    if (currentAmount > 0) {
      SanitizedLogger.error(`Unwanted donation detected. Total amount is > 0.`);
      SanitizedLogger.error(`[FAIL-SAFE] Unwanted donation detected: total amount is ₹${currentAmount} > 0.`);

      // Search the page for any radio buttons with text "No" that are currently unchecked
      const uncheckedNoCandidates = [
        'mat-radio-button:not(.mat-radio-checked):has-text("No")',
        'mat-radio-button:not([aria-checked="true"]):has-text("No")',
        'input[type="radio"][value="no" i]:not(:checked)',
        'input[type="radio"][value="No"]:not(:checked)',
        'input[type="radio"][value="N"]:not(:checked)',
      ];

      for (const sel of uncheckedNoCandidates) {
        const loc = page.locator(sel);
        if (typeof loc?.count === 'function') {
          const count = await loc.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const btn = loc.nth(i);
            if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
              SanitizedLogger.info(`[FAIL-SAFE] Clicking unchecked "No" radio button: ${sel} [${i}]`);
              await btn.scrollIntoViewIfNeeded().catch(() => {});
              await btn.click({ force: false }).catch(async () => {
                await btn.check().catch(() => {});
              });
            }
          }
        }
      }

      // Check any mat-radio-group where "No" is not selected
      const allRadioGroups = page.locator('mat-radio-group');
      if (typeof allRadioGroups?.count === 'function') {
        const groupCount = await allRadioGroups.count().catch(() => 0);
        for (let g = 0; g < groupCount; g++) {
          const group = allRadioGroups.nth(g);
          if (typeof group.locator === 'function') {
            const hasCheckedNo = (await group.locator('.mat-radio-checked:has-text("No"), input:checked[value="no" i], [aria-checked="true"]:has-text("No")').count().catch(() => 0)) > 0;
            if (!hasCheckedNo) {
              const noBtn = group.locator('mat-radio-button:has-text("No"), input[value="no" i], label:has-text("No")').first();
              if (await noBtn.isVisible({ timeout: 200 }).catch(() => false)) {
                SanitizedLogger.info(`[FAIL-SAFE] Clicking "No" in radio group #${g}`);
                await noBtn.click().catch(() => {});
              }
            }
          }
        }
      }

      await page.waitForTimeout(600);

      // Re-scan total amount
      currentAmount = await this.scanTotalAmount(page);

      if (currentAmount > 0) {
        SanitizedLogger.error(`[FAIL-SAFE] Total amount is STILL > 0 (₹${currentAmount}) after attempting opt-out on all "No" controls. Aborting booking.`);
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'RELIEF_FUND_SELECTION_FAILED',
          `Unwanted donation detected. Total amount is > 0 (₹${currentAmount}) after attempting to click "No". It is better to lose the slot than to steal money from a devotee.`,
          'PHASE_6_RELIEF_FUND',
          diag,
        );
      } else {
        SanitizedLogger.info('[FAIL-SAFE] Unwanted donation successfully neutralized. Total amount is now ₹0.');
      }
    } else {
      SanitizedLogger.info('[FAIL-SAFE] Fail-safe verified: Total donation amount = ₹0.');
    }
  }

  /**
   * PHASE 6: Aggressively opts out of ALL donation prompts (Pilgrim Relief Fund & Clean Sabarimala)
   * and runs the fail-safe to guarantee Amount = ₹0.
   */
  static async execute(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    SanitizedLogger.info(`[RELIEF-FUND] Initiating donation opt-out for Booking #${ctx.bookingCode}`);

    try {
      // 1. Opt out of Pilgrim Relief Fund
      await this.handlePilgrimReliefFund(page, ctx);

      // 2. Opt out of Clean Sabarimala Project
      await this.handleCleanSabarimala(page, ctx);

      // 3. Fail-Safe Safety Net: verify total amount is 0, auto-correct, or abort
      await this.enforceZeroDonationFailSafe(page, ctx);

      ctx.reliefFund = 0;
      ctx.reliefFundSelection = 'NO';
      SanitizedLogger.info('[RELIEF-FUND] All donations successfully opted out. Verified Total Amount = ₹0.');

      return true;
    } catch (err: any) {
      if (err instanceof VirtualQWorkflowError) throw err;
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_6_RELIEF_FUND', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'RELIEF_FUND_SELECTION_FAILED',
        err.message || 'Failed opting out of donation prompts (Amount > ₹0)',
        'PHASE_6_RELIEF_FUND',
        diag,
      );
    }
  }
}
