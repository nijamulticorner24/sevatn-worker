import { BrowserContext, Page } from 'playwright';
import { ContextManager } from '../browser/context-manager';
import { SabarimalaLoginFlow, LoginResult } from './login';
import {
  SabarimalaDarshanAvailabilityFlow,
  CheckResult,
  DateAvailabilityCheckResult,
  DiscoveredSlot,
  AvailabilityCheckOptions,
} from './darshan-availability';
import { SabarimalaPostLoginFlow } from './post-login-flow';
import { WishlistFlow, PaymentReviewFlow, BookingConfirmationFlow } from './flows';
import { SABARIMALA_SELECTORS } from './selectors';
import { SanitizedLogger } from '../monitoring/logger';
import { normalizeDate } from './virtual-q';

export class PlaywrightSabarimalaAdapter {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pageLock: Promise<void> = Promise.resolve();

  /**
   * Serializes operations against the shared Playwright page to prevent race conditions
   * across multiple monitoring keys or concurrent tasks.
   */
  async withPageLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentLock = this.pageLock;
    this.pageLock = nextLock;
    await currentLock;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  async init(): Promise<void> {
    const session = await ContextManager.createIsolatedContext();
    this.context = session.context;
    this.page = session.page;
  }

  // Pre-Login Darshan Availability Flow
  async openDarshanAvailability(): Promise<{ success: boolean; url: string; title: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.withPageLock(async () => {
      return await SabarimalaDarshanAvailabilityFlow.openDarshanAvailability(this.page!);
    });
  }

  // GAP-15 / REFRESH-01: typed CheckResult with serialized fresh data lifecycle
  async checkRequestedDateAvailability(
    requestedDate: string | Date,
    options?: AvailabilityCheckOptions,
  ): Promise<CheckResult> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.withPageLock(async () => {
      return await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(this.page!, requestedDate, options);
    });
  }

  async selectRequestedDate(requestedDate: string | Date): Promise<{ success: boolean; selectedDate: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaDarshanAvailabilityFlow.selectDate(this.page, requestedDate);
  }

  async selectRoute(route: string): Promise<{ success: boolean; selectedRoute: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaDarshanAvailabilityFlow.selectRoute(this.page, route);
  }

  async discoverAvailableSlots(): Promise<DiscoveredSlot[]> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaDarshanAvailabilityFlow.discoverAvailableSlots(this.page);
  }

  async selectAvailableTimeSlot(preferredTimeSlot?: string): Promise<{ success: boolean; selectedSlot: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaDarshanAvailabilityFlow.selectTimeSlot(this.page, preferredTimeSlot);
  }

  async proceedToLogin(): Promise<{ success: boolean }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaDarshanAvailabilityFlow.proceedToLogin(this.page);
  }

  // Authentication
  async openLogin(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      SanitizedLogger.info(`Navigating to official portal: ${SABARIMALA_SELECTORS.urls.login}`);
      await this.page.goto(SABARIMALA_SELECTORS.urls.login, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      return true;
    } catch (err: any) {
      SanitizedLogger.error('Failed to open login page:', err);
      return false;
    }
  }

  async login(username: string, password: string): Promise<LoginResult> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaLoginFlow.execute(this.page, username, password);
  }

  // Post-Login Sequence
  async handlePostLoginPopup(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.handlePostLoginPopup(this.page);
  }

  async navigateToHomeAndDarshan(ctx?: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.navigateToHomeAndDarshan(this.page, ctx);
  }

  async selectAuthenticatedDateAndRoute(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.selectAuthenticatedDateAndRoute(this.page, ctx);
  }

  async ensureBookingPageReady(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.ensureBookingPageReady(this.page, ctx);
  }

  async selectPostLoginTimeSlot(ctx: any): Promise<{ success: boolean; selectedSlot: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.selectPostLoginTimeSlot(this.page, ctx);
  }

  async selectBookingType(ctx: any): Promise<{ success: boolean; selectedType: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.selectBookingType(this.page, ctx);
  }

  verifyDateTimePreserved(ctx: any): boolean {
    return SabarimalaPostLoginFlow.verifyDateTimePreserved(ctx);
  }

  async selectAllExistingPilgrims(ctx: any): Promise<{ success: boolean; count: number }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.selectRegisteredPilgrims(this.page, ctx);
  }

  async populateNomineeDetails(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.populateNomineeDetails(this.page, ctx);
  }

  async handlePrasadamDetails(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.handlePrasadamDetails(this.page, ctx);
  }

  async selectReliefFundNo(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.selectReliefFundNo(this.page, ctx);
  }

  async checkWishlistForItem(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.checkWishlistForItem(this.page, ctx);
  }

  async addToWishlistAndVerify(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await WishlistFlow.execute(this.page, ctx);
  }

  async proceedToPaymentGateway(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    const result = await PaymentReviewFlow.execute(this.page, ctx);
    return result.loaded && result.checkoutVerified;
  }

  async verifyPaymentSummary(ctx: any): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.verifyPaymentSummary(this.page, ctx);
  }

  async checkExistingBookingInHistory(ctx: any): Promise<{ found: boolean; officialReference?: string; confirmedAt?: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.checkExistingBookingInHistory(this.page, ctx);
  }

  async executePaymentProceedAndConfirm(
    ctx: any,
  ): Promise<{
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
    if (!this.page) throw new Error('Browser not initialized');
    return await SabarimalaPostLoginFlow.executePaymentProceedAndConfirm(this.page, ctx);
  }

  async detectCurrentState(): Promise<string> {
    if (!this.page) return 'CLOSED';
    const url = this.page.url();
    if (url.includes('darshanAvailability')) return 'AVAILABILITY_PAGE';
    if (url.includes('login')) return 'LOGIN_PAGE';
    if (url.includes('darshan') || url.includes('virtual-q')) return 'VIRTUAL_Q_PAGE';
    if (url.includes('piligrimServiceMaster')) return 'PILGRIM_SELECTION_PAGE';
    if (url.includes('wishlist')) return 'WISHLIST_PAGE';
    return 'DASHBOARD';
  }

  async clearWishlistOnDarshan(ctx: any): Promise<void> {
    if (!this.page) return;
    await PaymentReviewFlow.clearWishlistOnDarshan(this.page, ctx);
  }

  getPage(): Page | null {
    return this.page;
  }

  getCurrentUrl(): string {
    return this.page?.url() || '';
  }

  /**
   * Captures the live Playwright browser page screenshot from https://sabarimalaonline.org/ as a base64 Data URL.
   * Waits briefly for any Angular error toast, OTP modal, or validation alert to finish rendering.
   * Uses JPEG quality 80 for optimal clarity and fast network transmission.
   * Attempts fullPage first; falls back to viewport screenshot if DOM animation or scrolling fails.
   */
  async captureScreenshotBase64(): Promise<string | null> {
    try {
      if (!this.page || this.page.isClosed()) return null;
      // Allow any active Angular popup, error toast, or validation message on sabarimalaonline.org to paint
      await this.page.waitForTimeout(400).catch(() => {});
      let buffer: Buffer;
      try {
        buffer = await this.page.screenshot({
          type: 'jpeg',
          quality: 80,
          fullPage: true,
          timeout: 4000,
        });
      } catch {
        buffer = await this.page.screenshot({
          type: 'jpeg',
          quality: 80,
          fullPage: false,
          timeout: 3000,
        });
      }
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (err: any) {
      SanitizedLogger.warn(`[ADAPTER] Failed to capture sabarimalaonline.org screenshot: ${err?.message || err}`);
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.context && this.page) {
      await ContextManager.cleanup(this.context, this.page);
      this.context = null;
      this.page = null;
    }
  }
}

