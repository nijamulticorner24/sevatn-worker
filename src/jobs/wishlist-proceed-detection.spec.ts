import { Page } from 'playwright';
import { WishlistFlow } from '../sabarimala/flows/wishlist.flow';
import { PaymentReviewFlow } from '../sabarimala/flows/payment-review.flow';
import { BookingExecutionContext } from '../sabarimala/flows/types';
import { BookingWorker } from './booking-worker';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { SanitizedLogger } from '../monitoring/logger';
import { BookingExecutionGuard } from '../security/execution-guard';
import { TelegramFailureNotifier } from '../monitoring/telegram-notifier';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

function createMockLocator(overrides: Record<string, any> = {}): any {
  const loc: any = {
    count: jest.fn().mockResolvedValue(1),
    first: jest.fn().mockImplementation(() => loc),
    last: jest.fn().mockImplementation(() => loc),
    nth: jest.fn().mockImplementation(() => loc),
    locator: jest.fn().mockImplementation(() => loc),
    isVisible: jest.fn().mockResolvedValue(true),
    isDisabled: jest.fn().mockResolvedValue(false),
    innerText: jest.fn().mockResolvedValue(''),
    click: jest.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
    waitFor: jest.fn().mockResolvedValue(undefined),
    dispatchEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return loc;
}

describe("Sabarimala Worker - Initial Wishlist Cleanup & Sequential Booking Flow", () => {
  let mockPage: any;
  let infoLogs: string[] = [];
  let warnLogs: string[] = [];
  let errorLogs: string[] = [];

  beforeEach(() => {
    BookingExecutionGuard.clearAll();
    infoLogs = [];
    warnLogs = [];
    errorLogs = [];
    jest.spyOn(SanitizedLogger, 'info').mockImplementation((msg: string) => {
      infoLogs.push(msg);
    });
    jest.spyOn(SanitizedLogger, 'warn').mockImplementation((msg: string) => {
      warnLogs.push(msg);
    });
    jest.spyOn(SanitizedLogger, 'error').mockImplementation((msg: string) => {
      errorLogs.push(msg);
    });
  });

  afterEach(() => {
    BookingExecutionGuard.clearAll();
    jest.restoreAllMocks();
  });

  const exactScreenshotWishlistText = `
    Virtual-Q
    Date 28-11-2026
    Time 07:00 - 08:00
    No. of Pilgrims 1
    Relief Fund Amount (₹) 0
    Clean Sabarimala Fund (₹) 0
  `;

  const staleOldWishlistText = `
    Virtual-Q
    Date 06-12-2026
    Time 12:00 - 13:00
    No. of Pilgrims 1
    Slot Unavailable
  `;

  const standardCtx: BookingExecutionContext = {
    bookingId: 'req-wishlist-test',
    bookingCode: 'TA-10011',
    requestedDate: '2026-11-28',
    requestedDateDisplay: '28-11-2026',
    requestedRoute: 'Pamba',
    selectedTimeSlot: '07:00 - 08:00',
    pilgrimCount: 1,
    reliefFund: 0,
  };

  it('1. Old Wishlist item exists after login -> clear it -> verify empty -> select slot', async () => {
    let clearWishlistClicked = false;
    let itemsCount = 1;

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel === 'app-wishlist' || sel.includes('My Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockImplementation(async () => itemsCount > 0 ? staleOldWishlistText : ''),
          });
        }
        if (sel.includes('Clear Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              clearWishlistClicked = true;
              itemsCount = 0;
            }),
          });
        }
        if (sel.includes('item') || sel.includes('wishlist-list') || sel.includes('table tbody tr') || sel.includes('wishlist-card')) {
          return createMockLocator({
            count: jest.fn().mockImplementation(async () => itemsCount),
            nth: jest.fn().mockReturnValue(createMockLocator({
              innerText: jest.fn().mockImplementation(async () => itemsCount > 0 ? staleOldWishlistText : ''),
              isVisible: jest.fn().mockImplementation(async () => itemsCount > 0),
            })),
          });
        }
        if (sel.includes('btn-delete') || sel.includes('delete')) {
          return createMockLocator({
            count: jest.fn().mockImplementation(async () => itemsCount),
            first: jest.fn().mockReturnValue(createMockLocator({
              isVisible: jest.fn().mockImplementation(async () => itemsCount > 0),
              click: jest.fn().mockImplementation(async () => { itemsCount = 0; }),
            })),
          });
        }
        if (sel.includes('Yes') || sel.includes('Confirm') || sel.includes('OK')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockResolvedValue(undefined),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const cleanupResult = await WishlistFlow.initialWishlistCleanup(mockPage, standardCtx);

    expect(cleanupResult).toBe(true);
    expect(clearWishlistClicked).toBe(true);
    expect(itemsCount).toBe(0);

    // Verify structured logs in exact sequence
    expect(infoLogs.some(log => log.includes('[INITIAL_WISHLIST_CHECK]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[INITIAL_WISHLIST_ITEMS_FOUND]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[CLEAR_WISHLIST_CLICKED]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[INITIAL_WISHLIST_EMPTY_VERIFIED]'))).toBe(true);
  });

  it('2. Wishlist empty after login -> continue without clicking Add Wishlist', async () => {
    let clearClicked = false;
    let addClicked = false;

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel === 'app-wishlist' || sel.includes('My Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('No items in wishlist'),
          });
        }
        if (sel.includes('Clear Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(false),
            click: jest.fn().mockImplementation(async () => { clearClicked = true; }),
          });
        }
        if (sel.includes('Add to Wishlist')) {
          return createMockLocator({
            click: jest.fn().mockImplementation(async () => { addClicked = true; }),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const cleanupResult = await WishlistFlow.initialWishlistCleanup(mockPage, standardCtx);

    expect(cleanupResult).toBe(true);
    expect(clearClicked).toBe(false);
    expect(addClicked).toBe(false);

    expect(infoLogs.some(log => log.includes('[INITIAL_WISHLIST_CHECK]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[INITIAL_WISHLIST_EMPTY_VERIFIED]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[INITIAL_WISHLIST_ITEMS_FOUND]'))).toBe(false);
  });

  it('3. Add Wishlist is clicked only after slot and devotee selection', async () => {
    const callSequence: string[] = [];

    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true, state: 'AVAILABLE' }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockImplementation(async () => {
        callSequence.push('INITIAL_WISHLIST_CLEANUP');
        return true;
      }),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockImplementation(async () => {
        callSequence.push('SELECT_SLOT');
        return { success: true, selectedSlot: '07:00 - 08:00' };
      }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async () => {
        callSequence.push('SELECT_DEVOTEE');
        return { success: true, selectedPilgrim: { fullName: 'Devotee 1', identityFingerprint: 'fp_1' } };
      }),
      populateNomineeDetails: jest.fn().mockImplementation(async () => {
        callSequence.push('POPULATE_NOMINEE');
        return true;
      }),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockImplementation(async () => {
        callSequence.push('SELECT_RELIEF_NO');
        return true;
      }),
      addToWishlistAndVerify: jest.fn().mockImplementation(async () => {
        callSequence.push('ADD_TO_WISHLIST');
        return true;
      }),
      proceedToPaymentGateway: jest.fn().mockImplementation(async () => {
        callSequence.push('FIRST_PROCEED');
        return true;
      }),
      verifyPaymentSummary: jest.fn().mockImplementation(async () => {
        callSequence.push('CHECKOUT_VERIFIED');
        return true;
      }),
      executePaymentProceedAndConfirm: jest.fn().mockImplementation(async () => {
        callSequence.push('SECOND_PROCEED_AND_CONFIRM');
        return {
          confirmed: true,
          officialReference: 'IVQ26112810001',
          officialBookingReference: 'IVQ26112810001',
          confirmedAt: new Date().toISOString(),
        };
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const jobPayload: any = {
      id: 'job-order-test-1',
      bookingId: 'req-order-test-1',
      bookingCode: 'TA-10011',
      leaseGeneration: 1,
      fencingToken: 'fence-order-1',
      requestedDate: '2026-11-28',
      requestedDateDisplay: '28-11-2026',
      route: 'Pamba',
      selectedTime: '07:00 - 08:00',
      timeSlot: '07:00 - 08:00',
      pilgrimCount: 1,
      pilgrims: [
        {
          id: 'p-1',
          fullName: 'Devotee 1',
          metadata: { taskStatus: 'PENDING' },
        },
      ],
      nominee: {
        nomineeName: 'Nominee 1',
        nomineeAge: 32,
        nomineeRelationship: 'FATHER',
        nomineePhone: '9876543210',
      },
      account: {
        id: 'acc-1',
        username: 'devotee_user',
        encryptedPassword: 'enc:password',
        encryptionIv: 'iv:mock',
        encryptionTag: 'tag:mock',
      },
    };

    await worker.execute(jobPayload);

    // Verify exact ordering:
    // 1. INITIAL_WISHLIST_CLEANUP
    // 2. SELECT_SLOT
    // 3. SELECT_DEVOTEE
    // 4. POPULATE_NOMINEE
    // 5. SELECT_RELIEF_NO
    // 6. ADD_TO_WISHLIST
    // 7. FIRST_PROCEED
    // 8. CHECKOUT_VERIFIED
    // 9. SECOND_PROCEED_AND_CONFIRM
    expect(callSequence).toEqual([
      'INITIAL_WISHLIST_CLEANUP',
      'SELECT_SLOT',
      'SELECT_DEVOTEE',
      'POPULATE_NOMINEE',
      'SELECT_RELIEF_NO',
      'ADD_TO_WISHLIST',
      'FIRST_PROCEED',
      'CHECKOUT_VERIFIED',
      'SECOND_PROCEED_AND_CONFIRM',
    ]);

    expect(infoLogs.some(log => log.includes('[CURRENT_SLOT_SELECTED]'))).toBe(true);
  });

  it('4. New Wishlist appears and matches the current booking', async () => {
    let addBtnClicked = false;

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Add to Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            isDisabled: jest.fn().mockResolvedValue(false),
            click: jest.fn().mockImplementation(async () => { addBtnClicked = true; }),
          });
        }
        if (sel === 'app-wishlist' || sel.includes('My Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue(exactScreenshotWishlistText),
          });
        }
        if (sel.includes('item') || sel.includes('wishlist-list') || sel.includes('table tbody tr') || sel.includes('wishlist-card')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            nth: jest.fn().mockReturnValue(createMockLocator({
              innerText: jest.fn().mockResolvedValue(exactScreenshotWishlistText),
              isVisible: jest.fn().mockResolvedValue(true),
            })),
          });
        }
        if (sel.includes('Proceed')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            isDisabled: jest.fn().mockResolvedValue(false),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const res = await WishlistFlow.execute(mockPage, standardCtx);

    expect(res).toBe(true);
    expect(addBtnClicked).toBe(true);

    expect(infoLogs.some(log => log.includes('[NEW_WISHLIST_ADD_CLICKED]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[NEW_WISHLIST_ITEM_VERIFIED]'))).toBe(true);
  });

  it('4b. Wishlist drawer recovery: When drawer does not appear immediately, refresh once and verify', async () => {
    let reloaded = false;
    let reloadCount = 0;

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockImplementation(async () => {
        reloadCount++;
        reloaded = true;
      }),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Add to Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            isDisabled: jest.fn().mockResolvedValue(false),
            click: jest.fn().mockResolvedValue(undefined),
          });
        }
        if (sel === 'app-wishlist' || sel.includes('My Wishlist')) {
          return createMockLocator({
            // Visible only AFTER reload!
            isVisible: jest.fn().mockImplementation(async () => reloaded),
            innerText: jest.fn().mockImplementation(async () => reloaded ? exactScreenshotWishlistText : ''),
          });
        }
        if (sel.includes('item') || sel.includes('wishlist-list') || sel.includes('table tbody tr') || sel.includes('wishlist-card')) {
          return createMockLocator({
            count: jest.fn().mockImplementation(async () => reloaded ? 1 : 0),
            nth: jest.fn().mockReturnValue(createMockLocator({
              innerText: jest.fn().mockImplementation(async () => reloaded ? exactScreenshotWishlistText : ''),
              isVisible: jest.fn().mockImplementation(async () => reloaded),
            })),
          });
        }
        if (sel.includes('Proceed')) {
          return createMockLocator({
            isVisible: jest.fn().mockImplementation(async () => reloaded),
            isDisabled: jest.fn().mockResolvedValue(false),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const res = await WishlistFlow.execute(mockPage, standardCtx);

    expect(res).toBe(true);
    expect(reloadCount).toBe(1); // EXACTLY ONCE!
    expect(warnLogs.some(log => log.includes('[WISHLIST_RECOVERY_REFRESH_ONCE]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[NEW_WISHLIST_ADD_CLICKED]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[NEW_WISHLIST_ITEM_VERIFIED]'))).toBe(true);
  });

  it('4c. Wishlist drawer recovery: If not present after single refresh, fails with WISHLIST_DRAWER_NOT_FOUND without extra refreshes', async () => {
    let reloadCount = 0;

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockImplementation(async () => {
        reloadCount++;
      }),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Add to Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            isDisabled: jest.fn().mockResolvedValue(false),
            click: jest.fn().mockResolvedValue(undefined),
          });
        }
        // Always hidden
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    await expect(WishlistFlow.execute(mockPage, standardCtx)).rejects.toThrow(/WISHLIST_DRAWER_NOT_FOUND/);
    expect(reloadCount).toBe(1); // EXACTLY 1 refresh, never repeated 3 times
    expect(warnLogs.some(log => log.includes('[WISHLIST_RECOVERY_REFRESH_ONCE]'))).toBe(true);
  });

  it('5. Both Proceed steps are executed with official Booking Confirmation popup, OK click and Transaction History verification', async () => {
    let firstProceedClicked = false;
    let secondProceedClicked = false;
    let okBtnClicked = false;
    let currentUrl = 'https://sabarimalaonline.org/#/darshan';

    const sampleTxnId = 'TXN281120261188';
    const samplePassId = 'IVQ26112899999';

    const confirmationPopupText = `
      Booking Confirmation
      Your transaction is successful with Transaction ID: ${sampleTxnId}
    `;

    const transactionHistoryRowText = `
      1 | ${sampleTxnId} | ${samplePassId} | 28-11-2026 | 07:00 - 08:00 | Pamba | 1 Pilgrim | CONFIRMED
    `;

    const proceedLocator = createMockLocator({
      isVisible: jest.fn().mockResolvedValue(true),
      isDisabled: jest.fn().mockResolvedValue(false),
      click: jest.fn().mockImplementation(async () => {
        firstProceedClicked = true;
        currentUrl = 'https://sabarimalaonline.org/#/paymentGateway';
      }),
    });

    const okButtonLocator = createMockLocator({
      isVisible: jest.fn().mockResolvedValue(true),
      click: jest.fn().mockImplementation(async () => {
        okBtnClicked = true;
        currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
      }),
    });

    mockPage = {
      url: jest.fn().mockImplementation(() => currentUrl),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockImplementation(async (pattern: any) => {
        if (String(pattern).includes('paymentGateway')) {
          currentUrl = 'https://sabarimalaonline.org/#/paymentGateway';
        } else if (String(pattern).includes('TransactionHistory')) {
          currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
        }
      }),
      innerText: jest.fn().mockImplementation(async (sel: string) => {
        if (currentUrl.includes('TransactionHistory')) {
          return transactionHistoryRowText;
        }
        if (currentUrl.includes('paymentGateway')) {
          if (secondProceedClicked) {
            return confirmationPopupText;
          }
          return 'Payment Gateway Grand Total: ₹0.00 | Date: 28-11-2026 | Route: Pamba | Time: 07:00 - 08:00';
        }
        return exactScreenshotWishlistText;
      }),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel === 'app-wishlist' || sel.includes('My Wishlist')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue(exactScreenshotWishlistText),
            locator: jest.fn().mockImplementation((childSel: string) => {
              if (childSel.includes('Proceed')) {
                return proceedLocator;
              }
              return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false) });
            }),
          });
        }
        if (sel.includes('item') || sel.includes('wishlist-list') || sel.includes('table tbody tr') || sel.includes('wishlist-card')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            nth: jest.fn().mockReturnValue(createMockLocator({
              innerText: jest.fn().mockImplementation(async () => {
                if (currentUrl.includes('TransactionHistory')) return transactionHistoryRowText;
                return exactScreenshotWishlistText;
              }),
              isVisible: jest.fn().mockResolvedValue(true),
            })),
          });
        }
        if (sel.includes('Proceed to Pay') || sel.includes('Process') || sel.includes('Confirm')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              secondProceedClicked = true;
            }),
          });
        }
        if (sel.includes('Booking Confirmation') || sel.includes('transaction is successful')) {
          return createMockLocator({
            isVisible: jest.fn().mockImplementation(async () => secondProceedClicked),
            innerText: jest.fn().mockResolvedValue(confirmationPopupText),
            locator: jest.fn().mockImplementation((childSel: string) => {
              if (childSel.includes('OK')) {
                return okButtonLocator;
              }
              return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false) });
            }),
          });
        }
        if (sel.includes('OK')) {
          return okButtonLocator;
        }
        if (sel.includes('Proceed')) {
          return proceedLocator;
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    // Step A: First Proceed in Wishlist panel
    const firstProceedRes = await PaymentReviewFlow.execute(mockPage, standardCtx);
    expect(firstProceedRes.loaded).toBe(true);
    expect(firstProceedRes.checkoutVerified).toBe(true);
    expect(firstProceedClicked).toBe(true);

    // Step B: Second Proceed on #/paymentGateway with popup and Transaction History
    const secondProceedRes = await PaymentReviewFlow.authorizeAndSubmitPayment(mockPage, {
      ...standardCtx,
      officialBookingReference: samplePassId,
    });

    expect(secondProceedClicked).toBe(true);
    expect(okBtnClicked).toBe(true);
    expect(secondProceedRes.confirmed).toBe(true);
    expect(secondProceedRes.portalTransactionReference).toBe(sampleTxnId);

    // Verify structured logs in chronological order
    const firstIdx = infoLogs.findIndex(log => log.includes('[FIRST_PROCEED_CLICKED]'));
    const verifyIdx = infoLogs.findIndex(log => log.includes('[CHECKOUT_PAGE_VERIFIED]'));
    const secondIdx = infoLogs.findIndex(log => log.includes('[SECOND_PROCEED_CLICKED]'));
    const popupIdx = infoLogs.findIndex(log => log.includes('[OFFICIAL_BOOKING_SUCCESS_POPUP_DETECTED]'));
    const txnIdx = infoLogs.findIndex(log => log.includes('[OFFICIAL_TRANSACTION_ID_CAPTURED]'));
    const okIdx = infoLogs.findIndex(log => log.includes('[SUCCESS_POPUP_OK_CLICKED]'));
    const navIdx = infoLogs.findIndex(log => log.includes('[TRANSACTION_HISTORY_NAVIGATION_VERIFIED]'));
    const recordIdx = infoLogs.findIndex(log => log.includes('[TRANSACTION_HISTORY_RECORD_VERIFIED]'));
    const confirmedIdx = infoLogs.findIndex(log => log.includes('[OFFICIAL_BOOKING_CONFIRMED]'));

    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeGreaterThan(verifyIdx);
    expect(popupIdx).toBeGreaterThan(secondIdx);
    expect(txnIdx).toBeGreaterThan(popupIdx);
    expect(okIdx).toBeGreaterThan(txnIdx);
    expect(navIdx).toBeGreaterThan(okIdx);
    expect(recordIdx).toBeGreaterThan(navIdx);
    expect(confirmedIdx).toBeGreaterThan(recordIdx);
  });

  it('5b. If Booking Confirmation popup does not appear, enter safe reconciliation without guessing', async () => {
    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/paymentGateway'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      innerText: jest.fn().mockResolvedValue('Still on payment page without popup'),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Proceed') || sel.includes('Process')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockResolvedValue(undefined),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const res = await PaymentReviewFlow.authorizeAndSubmitPayment(mockPage, standardCtx);
    expect(res.confirmed).toBe(false);
    expect(res.reconciliationRequired).toBe(true);
    expect(warnLogs.some(log => log.includes('Official booking success popup did not appear within timeout'))).toBe(true);
  });

  it('5c. If popup appears but OK/navigation fails, preserve Transaction ID and enter reconciliation rather than resubmitting', async () => {
    const sampleTxnId = 'TXN5555566666';
    const popupText = `
      Booking Confirmation
      Your transaction is successful with Transaction ID: ${sampleTxnId}
    `;

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/paymentGateway'), // NEVER navigated to TransactionHistory!
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockRejectedValue(new Error('Timeout navigating to TransactionHistory')),
      innerText: jest.fn().mockResolvedValue(popupText),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Proceed') || sel.includes('Process')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockResolvedValue(undefined),
          });
        }
        if (sel.includes('Booking Confirmation') || sel.includes('transaction is successful')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue(popupText),
          });
        }
        if (sel.includes('OK')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockResolvedValue(undefined),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const res = await PaymentReviewFlow.authorizeAndSubmitPayment(mockPage, standardCtx);
    expect(res.confirmed).toBe(false);
    expect(res.reconciliationRequired).toBe(true);
    expect(res.portalTransactionReference).toBe(sampleTxnId);
    expect(infoLogs.some(log => log.includes('[OFFICIAL_BOOKING_SUCCESS_POPUP_DETECTED]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[OFFICIAL_TRANSACTION_ID_CAPTURED]'))).toBe(true);
    expect(infoLogs.some(log => log.includes('[SUCCESS_POPUP_OK_CLICKED]'))).toBe(true);
    expect(warnLogs.some(log => log.includes('Preserving Transaction ID for reconciliation'))).toBe(true);
  });

  it('6. Failed cleanup returns safely to watching/queue without duplicate booking', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(false), // CLEANUP FAILS!
      verifyCarriedDateAndRoute: jest.fn(),
      selectPostLoginSlotWithRefreshFallback: jest.fn(),
      selectSingleSavedPilgrim: jest.fn(),
      addToWishlistAndVerify: jest.fn(),
      proceedToPaymentGateway: jest.fn(),
      executePaymentProceedAndConfirm: jest.fn(),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const jobPayload: any = {
      id: 'job-cleanup-fail-1',
      bookingId: 'req-cleanup-fail-1',
      bookingCode: 'TA-10012',
      leaseGeneration: 1,
      fencingToken: 'fence-fail-1',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '07:00 - 08:00',
      pilgrimCount: 1,
      nominee: {
        nomineeName: 'Nominee A',
        nomineeAge: 25,
        nomineeRelationship: 'SON',
        nomineePhone: '9876543210',
      },
      account: {
        id: 'acc-1',
        username: 'devotee_user',
        encryptedPassword: 'enc:password',
        encryptionIv: 'iv:mock',
        encryptionTag: 'tag:mock',
      },
    };

    await worker.execute(jobPayload);

    // Invariants for failed cleanup:
    // 1. failJob is called with WISHLIST_CLEANUP_FAILED
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-cleanup-fail-1',
      expect.objectContaining({
        errorCode: 'WISHLIST_CLEANUP_FAILED',
        status: 'RETRYABLE_FAILURE',
      }),
    );

    // 2. No slot selection, no pilgrim selection, no Add to Wishlist, no payment proceed
    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).not.toHaveBeenCalled();
    expect(mockAdapter.selectSingleSavedPilgrim).not.toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();
    expect(mockAdapter.proceedToPaymentGateway).not.toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).not.toHaveBeenCalled();

    // 3. completeJob is NEVER called
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  it('7. No success state without official confirmed pass', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '07:00 - 08:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockResolvedValue({
        success: true,
        selectedPilgrim: { fullName: 'Devotee 1', identityFingerprint: 'fp_1' },
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: false,
        reconciliationRequired: true,
        message: 'Timeout waiting for confirmation',
      }),
      checkExistingBookingInHistory: jest.fn().mockResolvedValue({
        found: false,
        officialStatusFound: 'CANCELLED',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const jobPayload: any = {
      id: 'job-unconfirmed-1',
      bookingId: 'req-unconfirmed-1',
      bookingCode: 'TA-10013',
      leaseGeneration: 1,
      fencingToken: 'fence-unconfirmed-1',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '07:00 - 08:00',
      pilgrimCount: 1,
      nominee: {
        nomineeName: 'Nominee A',
        nomineeAge: 25,
        nomineeRelationship: 'SON',
        nomineePhone: '9876543210',
      },
      account: {
        id: 'acc-1',
        username: 'devotee_user',
        encryptedPassword: 'enc:password',
        encryptionIv: 'iv:mock',
        encryptionTag: 'tag:mock',
      },
    };

    await worker.execute(jobPayload);

    // Invariant: Without authoritative confirmed pass, completeJob is NEVER called!
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    // Instead, failJob is called with RECONCILIATION_REQUIRED / CONFIRMATION_UNVERIFIED
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-unconfirmed-1',
      expect.objectContaining({
        status: 'RECONCILIATION_REQUIRED',
        errorCode: 'CONFIRMATION_UNVERIFIED',
      }),
    );
  });

  it('8. Official payment page displays "Sorry, this service is not available" -> aborts immediately, emits PORTAL_SERVICE_UNAVAILABLE_ABORTED, dispatches Telegram alert, releases locks, and returns to WATCHING', async () => {
    const errorPageText = `
      Travancore Devaswom Board Online Services
      Virtual-Q Booking
      Sorry, this service is not available. Kindly edit / remove the service through 'My Wishlist' to continue with the payment.
      Cart ID: 1928813475
      Booking ID: IVQ26112615490595521771
      Date / Slot: 28-11-2026 / 22:00 - 23:00
      No. of Pilgrims: 1
      Grand Total: ₹0.00
      Cancel Proceed
    `;

    let cancelClicked = false;
    let proceedClicked = false;

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/paymentGateway'),
      innerText: jest.fn().mockImplementation((sel: string) => {
        if (sel === 'body' || sel === '') return Promise.resolve(errorPageText);
        return Promise.resolve('');
      }),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Cancel')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              cancelClicked = true;
            }),
          });
        }
        if (sel.includes('Proceed') || sel.includes('Process')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              proceedClicked = true;
            }),
          });
        }
        return createMockLocator();
      }),
    };

    const sendAlertSpy = jest.spyOn(TelegramFailureNotifier, 'sendFailureAlert').mockResolvedValue({
      success: true,
      deliveredVia: 'LOGGER_ONLY',
    });

    const abortCtx: BookingExecutionContext = {
      bookingId: 'req-abort-10014',
      bookingCode: 'TA-10014',
      requestedDate: '2026-11-28',
      requestedDateDisplay: '28-11-2026',
      requestedRoute: 'Pamba',
      selectedTimeSlot: '22:00 - 23:00',
      pilgrimCount: 1,
      currentPilgrimIndex: 0,
      reliefFund: 0,
    };

    // Pre-acquire priority and execution locks to verify they get released on abort
    BookingExecutionGuard.acquireGlobalPriorityLock({
      demandKey: '2026-11-28:Pamba',
      bookingId: 'req-abort-10014',
      bookingCode: 'TA-10014',
      date: '2026-11-28',
      route: 'Pamba',
    });
    BookingExecutionGuard.acquire({
      bookingId: 'req-abort-10014',
      bookingCode: 'TA-10014',
      jobId: 'job-abort-10014',
      dispatchSource: 'TEST',
    });

    expect(BookingExecutionGuard.isBookingActive('TA-10014')).toBe(true);
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(true);

    // Call checkServiceUnavailableAndAbort
    let thrownError: any = null;
    try {
      await PaymentReviewFlow.checkServiceUnavailableAndAbort(mockPage, abortCtx);
    } catch (err: any) {
      thrownError = err;
    }

    // 1. Throws PORTAL_SERVICE_UNAVAILABLE error immediately
    expect(thrownError).toBeDefined();
    expect(thrownError.code).toBe('PORTAL_SERVICE_UNAVAILABLE');

    // 2. Do NOT click Proceed again
    expect(proceedClicked).toBe(false);

    // 3. Cancel button was clicked if available
    expect(cancelClicked).toBe(true);

    // 4. Full-page screenshot captured & context extracted
    expect(abortCtx.cartId).toBe('1928813475');
    expect(abortCtx.officialBookingReference).toBe('IVQ26112615490595521771');

    // 5. Telegram alert dispatched with details
    expect(sendAlertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingCode: 'TA-10014',
        requestedDate: '28-11-2026',
        route: 'Pamba',
        failureStage: 'PAYMENT_GATEWAY_SERVICE_UNAVAILABLE',
        errorMessage: expect.stringContaining('Sorry, this service is not available'),
      }),
    );

    // 6. Dedicated log marker PORTAL_SERVICE_UNAVAILABLE_ABORTED emitted
    const abortLog = errorLogs.find((l) => l.includes('[PORTAL_SERVICE_UNAVAILABLE_ABORTED]'));
    expect(abortLog).toBeDefined();
    expect(abortLog).toContain('TA-10014-PORTAL_SERVICE_UNAVAILABLE-');
    expect(abortLog).toContain('Telegram dispatch result:');

    // 7. Execution and global priority locks released
    expect(BookingExecutionGuard.isBookingActive('TA-10014')).toBe(false);
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
  });

  it('8b. BookingWorker handles PORTAL_SERVICE_UNAVAILABLE: reports failure and does NOT mark confirmed', async () => {
    const mockApiClient: any = {
      claimAvailableBooking: jest.fn().mockResolvedValue(null),
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '22:00 - 23:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockResolvedValue({
        success: true,
        selectedPilgrim: { fullName: 'Devotee 1', identityFingerprint: 'fp_1' },
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockRejectedValue({
        code: 'PORTAL_SERVICE_UNAVAILABLE',
        errorCode: 'PORTAL_SERVICE_UNAVAILABLE',
        message: "Sorry, this service is not available. Kindly edit / remove the service through 'My Wishlist' to continue with the payment.",
      }),
      executePaymentProceedAndConfirm: jest.fn(),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
      captureScreenshotBase64: jest.fn().mockResolvedValue(undefined),
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const jobPayload: any = {
      id: 'job-abort-10014',
      bookingId: 'req-abort-10014',
      bookingCode: 'TA-10014',
      leaseGeneration: 1,
      fencingToken: 'fence-abort-1',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '22:00 - 23:00',
      pilgrimCount: 1,
      nominee: {
        nomineeName: 'Nominee A',
        nomineeAge: 25,
        nomineeRelationship: 'SON',
        nomineePhone: '9876543210',
      },
      account: {
        id: 'acc-1',
        username: 'devotee_user',
        encryptedPassword: 'enc:password',
        encryptionIv: 'iv:mock',
        encryptionTag: 'tag:mock',
      },
    };

    await worker.execute(jobPayload);

    // Invariants:
    // 1. completeJob was NEVER called
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
    // 2. executePaymentProceedAndConfirm was NEVER called
    expect(mockAdapter.executePaymentProceedAndConfirm).not.toHaveBeenCalled();
    // 3. failJob called with PORTAL_SERVICE_UNAVAILABLE
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-abort-10014',
      expect.objectContaining({
        status: 'PORTAL_SERVICE_UNAVAILABLE',
        errorCode: 'PORTAL_SERVICE_UNAVAILABLE',
      }),
    );
  });

  it('9. Hidden Wishlist is marked UNKNOWN (not EMPTY), preventing slot selection', async () => {
    // When the right-side Wishlist panel is hidden (e.g. app-wishlist with no inner text, My Wishlist not visible)
    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel === 'app-wishlist') {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            // Empty inner text indicates unrendered/hidden drawer
            innerText: jest.fn().mockResolvedValue('   '),
          });
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'req-hidden-test',
      bookingCode: 'TA-10015',
      requestedDate: '2026-11-30',
      requestedDateDisplay: '30-11-2026',
      requestedRoute: 'Pamba',
      reliefFund: 0,
    };

    const verified = await WishlistFlow.initialWishlistCleanup(mockPage, ctx);

    // INVARIANT: Must return false and set wishlistStatus = 'UNKNOWN', NEVER 'EMPTY'
    expect(verified).toBe(false);
    expect(ctx.wishlistStatus).toBe('UNKNOWN');
    expect(warnLogs.some((l) => l.includes('[INITIAL_WISHLIST_UNKNOWN]'))).toBe(true);
    expect(infoLogs.some((l) => l.includes('INITIAL_WISHLIST_EMPTY_VERIFIED'))).toBe(false);
  });

  it('10. Telegram Failure Notifier returns DIRECT_CREDENTIALS_NOT_CONFIGURED without claiming false success', async () => {
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    const origChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    try {
      const result = await TelegramFailureNotifier.sendFailureAlert({
        bookingId: 'job-10015',
        bookingCode: 'TA-10015',
        requestedDate: '30-11-2026',
        route: 'Pamba',
        failureStage: 'PHASE_7_WISHLIST',
        errorMessage: 'Drawer remained hidden',
      });

      expect(result.success).toBe(false);
      expect(result.deliveredVia).toBe('LOGGER_ONLY');
      expect(result.error).toBe('DIRECT_CREDENTIALS_NOT_CONFIGURED');
    } finally {
      if (origToken) process.env.TELEGRAM_BOT_TOKEN = origToken;
      if (origChat) process.env.TELEGRAM_CHAT_ID = origChat;
    }
  });

  it('11. Test A: Official success popup with Transaction ID 1928814227 -> marks devotee CONFIRMED without requiring table row inspection', async () => {
    let okClicked = false;
    let currentUrl = 'https://sabarimalaonline.org/#/payment-gateway';

    const mockPage: any = {
      url: jest.fn().mockImplementation(() => currentUrl),
      waitForURL: jest.fn().mockImplementation(async (targetUrl: string) => {
        currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
      }),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      innerText: jest.fn().mockImplementation(async (sel: string) => {
        if (sel === 'body') {
          return currentUrl.includes('TransactionHistory')
            ? 'Transaction History. Loading records...'
            : 'Checkout and confirmation page';
        }
        return '';
      }),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('mock-png')),
      locator: jest.fn().mockImplementation((sel: string) => {
        const makeLoc = (selector: string): any => {
          return createMockLocator({
            isVisible: jest.fn().mockImplementation(async () => {
              if (selector.includes('Confirmation') || selector.includes('transaction is successful')) return true;
              if (selector.includes('OK') || selector.includes('Ok')) return true;
              if (selector.includes('Proceed')) return true;
              return false;
            }),
            innerText: jest.fn().mockImplementation(async () => {
              if (selector.includes('Confirmation') || selector.includes('dialog')) {
                return 'Booking Confirmation. Your transaction is successful with Transaction ID: 1928814227. Please note for reference.';
              }
              return '';
            }),
            click: jest.fn().mockImplementation(async () => {
              if (selector.includes('OK')) {
                okClicked = true;
                currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
              }
            }),
            locator: jest.fn().mockImplementation((subSel: string) => makeLoc(subSel)),
            count: jest.fn().mockImplementation(async () => {
              // History table rows are not rendered yet (verifying non-blocking requirement)
              if (selector.includes('tr') || selector.includes('mat-row') || selector.includes('table')) return 0;
              return 1;
            }),
          });
        };
        return makeLoc(sel);
      }),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      requestedDate: '2026-11-30',
      requestedDateDisplay: '30-11-2026',
      requestedRoute: 'Pamba',
      selectedTimeSlot: '16:00 - 17:00',
      pilgrimCount: 1,
      reliefFund: 0,
    };

    const { SabarimalaPostLoginFlow } = require('../sabarimala/post-login-flow');
    const result = await SabarimalaPostLoginFlow.executePaymentProceedAndConfirm(mockPage, ctx);

    // INVARIANTS:
    // 1. Current devotee MUST be marked confirmed
    expect(result.confirmed).toBe(true);
    // 2. Transaction ID 1928814227 must be captured as the official reference
    expect(result.officialReference).toBe('1928814227');
    expect(result.portalTransactionReference).toBe('1928814227');
    // 3. OK button must be clicked exactly once
    expect(okClicked).toBe(true);
    // 4. Must not require reconciliation
    expect(result.reconciliationRequired).toBeFalsy();
    // 5. Source must indicate official success popup and navigation
    expect(result.confirmationSource).toBe('OFFICIAL_SUCCESS_POPUP_AND_TRANSACTION_HISTORY_NAVIGATION');
  });

  it('12. Test B: Wishlist error after official success is safely suppressed and NEVER downgrades confirmed devotee', async () => {
    const mockApiClient: any = {
      claimAvailableBooking: jest.fn().mockResolvedValue(null),
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true, state: 'AVAILABLE' }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockResolvedValue({
        success: true,
        selectedPilgrim: { fullName: 'Baskar Duraisamy', identityFingerprint: 'fp_baskar_1' },
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      // Official confirmation succeeds with Transaction ID 1928814227
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814227',
        officialBookingReference: '1928814227',
        portalTransactionReference: '1928814227',
      }),
      // Late logout or cleanup error simulates a post-confirmation error
      logout: jest.fn().mockRejectedValue(new Error('WISHLIST_DRAWER_NOT_FOUND: Late drawer failure')),
      close: jest.fn().mockResolvedValue(true),
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const jobPayload: any = {
      id: 'job-ta-10015',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 1,
      fencingToken: 'fence-10015',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      pilgrims: [
        { id: 'p-1', fullName: 'Baskar Duraisamy', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
        { id: 'p-2', fullName: 'Devotee #2', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
        { id: 'p-3', fullName: 'Devotee #3', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      ],
      nominee: {
        nomineeName: 'Baskar Nominee',
        nomineeAge: 35,
        nomineeRelationship: 'BROTHER',
        nomineePhone: '9876543210',
      },
      account: {
        id: 'acc-10015',
        username: 'user_10015',
        encryptedPassword: 'enc:pass',
        encryptionIv: 'iv:mock',
        encryptionTag: 'tag:mock',
      },
    };

    await worker.execute(jobPayload);

    // INVARIANTS:
    // 1. completeJob WAS called for Devotee #1
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-ta-10015',
      expect.objectContaining({
        officialReference: '1928814227',
        taskIndex: 1,
        isFinalPilgrim: false,
      })
    );
    // 2. failJob WAS NOT called (late error safely suppressed)
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
  });

  it('13. Test C: Partial booking with 1 confirmed devotee and 2 pending selects Devotee #2 in next cycle', async () => {
    const mockApiClient: any = {
      claimAvailableBooking: jest.fn().mockResolvedValue(null),
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    let selectedPilgrimNum = 0;
    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true, state: 'AVAILABLE' }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedPilgrimNum = ctx.currentPilgrimIndex + 1;
        return {
          success: true,
          selectedPilgrim: { fullName: 'Devotee #2', identityFingerprint: 'fp_devotee_2' },
        };
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814228',
        officialBookingReference: '1928814228',
        portalTransactionReference: '1928814228',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    // Devotee #1 is ALREADY confirmed in DB/job payload
    const jobPayload: any = {
      id: 'job-seq-cycle-2',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 2,
      fencingToken: 'fence-10015-b',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      pilgrims: [
        { id: 'p-1', fullName: 'Baskar Duraisamy', metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: '1928814227' } },
        { id: 'p-2', fullName: 'Devotee #2', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
        { id: 'p-3', fullName: 'Devotee #3', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      ],
      nominee: {
        nomineeName: 'Baskar Nominee',
        nomineeAge: 35,
        nomineeRelationship: 'BROTHER',
        nomineePhone: '9876543210',
      },
      account: {
        id: 'acc-10015',
        username: 'user_10015',
        encryptedPassword: 'enc:pass',
        encryptionIv: 'iv:mock',
        encryptionTag: 'tag:mock',
      },
    };

    await worker.execute(jobPayload);

    // INVARIANT: Worker MUST select Devotee #2 (not Devotee #1 again!)
    expect(selectedPilgrimNum).toBe(2);
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-seq-cycle-2',
      expect.objectContaining({
        taskIndex: 2,
        isFinalPilgrim: false,
      })
    );
  });
});
