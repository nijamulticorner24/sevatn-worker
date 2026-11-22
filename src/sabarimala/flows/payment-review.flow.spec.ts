import { PaymentReviewFlow } from './payment-review.flow';
import { WishlistFlow } from './wishlist.flow';
import { BookingExecutionContext } from './types';
import { SanitizedLogger } from '../../monitoring/logger';

describe('PaymentReviewFlow & Wishlist Invalid Cart Recovery', () => {
  function createMockLocator(overrides: Record<string, any> = {}) {
    const loc: any = {
      isVisible: jest.fn().mockResolvedValue(true),
      isDisabled: jest.fn().mockResolvedValue(false),
      scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
      waitFor: jest.fn().mockResolvedValue(undefined),
      innerText: jest.fn().mockResolvedValue(''),
      count: jest.fn().mockResolvedValue(1),
      first: () => loc,
      nth: () => loc,
      ...overrides,
    };
    return loc;
  }

  it('handles Wishlist "Invalid" Proceed error: clears wishlist, re-adds item, and reaches #/paymentGateway', async () => {
    let proceedAttempts = 0;
    let clearClicked = false;
    let wishlistReAdded = false;
    let currentUrl = 'https://sabarimalaonline.org/#/darshan';

    const warnSpy = jest.spyOn(SanitizedLogger, 'warn');

    // Spy on WishlistFlow.execute to track re-adding
    jest.spyOn(WishlistFlow, 'execute').mockImplementation(async (page, ctx) => {
      wishlistReAdded = true;
      ctx.wishlistStatus = 'VERIFIED';
      return true;
    });

    const mockPage: any = {
      url: jest.fn().mockImplementation(() => currentUrl),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockImplementation(async (pattern: any, opts: any) => {
        if (proceedAttempts === 1) {
          // First attempt: simulate failure to reach paymentGateway (or timeout)
          throw new Error('Timeout waiting for URL');
        }
        currentUrl = 'https://sabarimalaonline.org/#/paymentGateway';
      }),
      innerText: jest.fn().mockImplementation(async (sel?: string) => {
        if (sel === 'body') {
          return 'Grand Total: ₹0.00 | Date: 24-11-2026 | Route: Pamba | Pilgrims: 1';
        }
        return '';
      }),
      locator: jest.fn().mockImplementation((sel: string) => {
        // Loader / shade
        if (sel.includes('loader') || sel.includes('shade')) {
          return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false) });
        }

        // Proceed button in Wishlist panel
        if (sel.includes('Proceed')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            isDisabled: jest.fn().mockResolvedValue(false),
            click: jest.fn().mockImplementation(async () => {
              proceedAttempts++;
              if (proceedAttempts === 1) {
                // First click fails to navigate and triggers Invalid toast
                currentUrl = 'https://sabarimalaonline.org/#/darshan';
              } else {
                currentUrl = 'https://sabarimalaonline.org/#/paymentGateway';
              }
            }),
          });
        }

        // Invalid error banner / toast
        if (sel.includes('Invalid') || sel.includes('toast') || sel.includes('alert')) {
          return createMockLocator({
            isVisible: jest.fn().mockImplementation(async () => proceedAttempts === 1 && !clearClicked),
            innerText: jest.fn().mockResolvedValue('Invalid cart state detected. Please clear cart.'),
          });
        }

        // Clear Wishlist button
        if (sel.includes('Clear Wishlist') || sel.includes('Clear')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              clearClicked = true;
            }),
          });
        }

        // Empty indicators
        if (sel.includes('empty') || sel.includes('No items')) {
          return createMockLocator({
            isVisible: jest.fn().mockImplementation(async () => clearClicked && !wishlistReAdded),
          });
        }

        // Existing wishlist items (pre-proceed check)
        if (sel.includes('app-wishlist') || sel.includes('wishlist-item') || sel.includes('table tbody tr') || sel.includes('.item')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            nth: () => createMockLocator({
              innerText: jest.fn().mockResolvedValue('Date: 24-11-2026 | Route: Pamba | Time: 03:00 - 04:00 | Relief Fund: 0'),
            }),
          });
        }

        // Total amount & Final Process/Confirm button on #/paymentGateway
        if (sel.includes('total-amount') || sel.includes('grand-total') || sel.includes('Total Amount')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('₹0.00'),
          });
        }

        if (sel.includes('Process') || sel.includes('Confirm')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
          });
        }

        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-invalid-recovery',
      bookingCode: 'TA-INVALID-01',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      selectedTimeSlot: '03:00 - 04:00',
      reliefFund: 0,
      pilgrimCount: 1,
    };

    const result = await PaymentReviewFlow.execute(mockPage, ctx);

    // Verify recovery steps
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WISHLIST] Proceed failed (Invalid cart). Attempting recovery...')
    );
    expect(clearClicked).toBe(true);
    expect(wishlistReAdded).toBe(true);
    expect(proceedAttempts).toBe(2);
    expect(mockPage.waitForURL).toHaveBeenCalledWith('**/#/paymentGateway', { timeout: 15000 });
    expect(result.loaded).toBe(true);
    expect(result.gatewayUrl).toContain('paymentGateway');
    expect(result.amount).toBe('₹0.00');
    expect(result.finalSubmitButtonFound).toBe(true);
  });

  it('verifies payment review page details and identifies final submit button without calling authorizePayment', async () => {
    let finalButtonClicked = false;
    const mockApiClient: any = {
      authorizePayment: jest.fn(),
    };

    const mockPage: any = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/paymentGateway'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockResolvedValue(undefined),
      innerText: jest.fn().mockImplementation(async (sel?: string) => {
        if (sel === 'body') return 'Grand Total: ₹0.00 | Date: 24-11-2026 | Route: Pamba';
        return '';
      }),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('loader') || sel.includes('shade')) {
          return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false) });
        }
        if (sel.includes('Proceed') || sel.includes('Process') || sel.includes('Confirm')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              finalButtonClicked = true;
            }),
          });
        }
        if (sel.includes('app-wishlist') || sel.includes('table tbody tr')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            nth: () => createMockLocator({
              innerText: jest.fn().mockResolvedValue('Date: 24-11-2026 | Route: Pamba | Time: 03:00 - 04:00 | Relief: 0'),
            }),
          });
        }
        if (sel.includes('total-amount') || sel.includes('grand-total')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('₹0.00'),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-auth-test',
      jobId: 'job-auth-99',
      leaseGeneration: 2,
      fencingToken: 'fencing-token-abc',
      apiClient: mockApiClient,
      bookingCode: 'TA-AUTH-01',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      selectedTimeSlot: '03:00 - 04:00',
      reliefFund: 0,
      pilgrimCount: 1,
    };

    const result = await PaymentReviewFlow.execute(mockPage, ctx);

    expect(result.loaded).toBe(true);
    expect(result.amount).toBe('₹0.00');
    // Invariant: authorizePayment gate is removed and never invoked
    expect(mockApiClient.authorizePayment).not.toHaveBeenCalled();

    // Call authorizeAndSubmitPayment to verify final button click
    const submitResult = await PaymentReviewFlow.authorizeAndSubmitPayment(mockPage, ctx);
    expect(submitResult.isZeroCost).toBe(true);
    expect(finalButtonClicked).toBe(true);
  });

  it('throws CONFIRM_BUTTON_NOT_FOUND when paymentGateway is loaded but an error occurs during checkout verification', async () => {
    const mockApiClient: any = {};
    const mockPage: any = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/paymentGateway'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockResolvedValue(undefined),
      innerText: jest.fn().mockResolvedValue('Grand Total: ₹0.00'),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Proceed') && !sel.includes('Pay')) {
          return createMockLocator({ isVisible: jest.fn().mockResolvedValue(true) });
        }
        if (sel.includes('app-wishlist')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            nth: () => createMockLocator({
              innerText: jest.fn().mockResolvedValue('Date: 24-11-2026 | Route: Pamba | Time: 03:00 - 04:00 | Relief: 0'),
            }),
          });
        }
        if (sel.includes('total-amount') || sel.includes('grand-total')) {
          throw new Error('DOM query exception on payment review page');
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-gateway-err',
      jobId: 'job-err-99',
      bookingCode: 'TA-ERR-01',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      reliefFund: 0,
    };

    await expect(PaymentReviewFlow.execute(mockPage, ctx)).rejects.toThrow(
      /CONFIRM_BUTTON_NOT_FOUND/
    );
  });

  it('clicks final Proceed without authorizePayment and extracts IVQ reference from DOM/dialog', async () => {
    let finalProceedClicked = false;
    const mockApiClient: any = {
      authorizePayment: jest.fn(),
    };

    const mockPage: any = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/paymentGateway'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockResolvedValue(undefined),
      innerText: jest.fn().mockImplementation(async (sel?: string) => {
        if (sel === 'body') {
          return 'Official Booking Reference: IVQ26112015000012345 | Transaction ID: TXN99887766';
        }
        return 'Booking Confirmation: IVQ26112015000012345';
      }),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Proceed to Pay') || sel.includes('Proceed') || sel.includes('Confirm') || sel.includes('Process')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              finalProceedClicked = true;
            }),
          });
        }
        if (sel.includes('confirmation') || sel.includes('dialog')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('Confirmation: IVQ26112015000012345'),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-success-test',
      jobId: 'job-success-99',
      leaseGeneration: 3,
      fencingToken: 'fencing-token-valid',
      apiClient: mockApiClient,
      bookingCode: 'TA-SUCCESS-01',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      selectedTimeSlot: '03:00 - 04:00',
      reliefFund: 0,
      pilgrimCount: 1,
    };

    const confirmResult = await PaymentReviewFlow.authorizeAndSubmitPayment(mockPage, ctx);

    // Invariant: authorizePayment gate is removed and never invoked
    expect(mockApiClient.authorizePayment).not.toHaveBeenCalled();
    expect(finalProceedClicked).toBe(true);
    expect(confirmResult.confirmed).toBe(true);
    expect(confirmResult.officialReference).toBe('IVQ26112015000012345');
    expect(ctx.officialBookingReference).toBe('IVQ26112015000012345');
  });
});
