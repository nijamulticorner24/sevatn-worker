import { BookingWorker } from './booking-worker';
import { BookingExecutionGuard } from '../security/execution-guard';
import { SabarimalaPostLoginFlow } from '../sabarimala/post-login-flow';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';

jest.mock('../sabarimala/sabarimala-adapter');

describe('Booking Confirmation Evidence & Multi-Devotee Flow Suite', () => {
  let mockApiClient: any;
  let mockAdapter: any;
  let baseJob: any;

  beforeEach(() => {
    jest.clearAllMocks();
    BookingExecutionGuard.clearAll();
    process.env.CREDENTIAL_ENCRYPTION_KEY = '12345678901234567890123456789012';
    jest.spyOn(CredentialManager, 'decrypt').mockReturnValue('password123');

    mockApiClient = {
      updateJobProgress: jest.fn().mockResolvedValue({ success: true }),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    mockAdapter = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      selectRequestedDate: jest.fn().mockResolvedValue({ success: true }),
      selectRoute: jest.fn().mockResolvedValue(true),
      proceedToLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({
        success: true,
        selectedSlot: '06:00 - 07:00',
        refreshAttempts: 0,
      }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockResolvedValue({
        success: true,
        selectedPilgrim: { fullName: 'BASKAR DURAISAMY', identityFingerprint: 'fp_baskar_1' },
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: 'IVQ261126232212212140',
        officialBookingReference: 'IVQ261126232212212140',
        portalTransactionReference: '1928818075',
        transactionId: '1928818075',
        cartId: '1928818075',
      }),
      logout: jest.fn().mockResolvedValue(true),
      captureScreenshotBase64: jest.fn().mockResolvedValue('mock-screenshot-base64'),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    baseJob = {
      id: 'job-confirm-evidence-001',
      bookingRequestId: 'req-confirm-001',
      bookingCode: 'TA-10018',
      requestedDate: '2026-11-27',
      route: 'Pamba - Marakkoottam - 4 Kms',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 2,
      leaseGeneration: 1,
      fencingToken: 'fnc_confirm_001',
      account: {
        id: 'acc-confirm-01',
        username: 'devotee@example.com',
        encryptedPassword: 'enc_password',
        encryptionIv: 'enc_iv',
        encryptionTag: 'enc_tag',
      },
      nominee: {
        nomineeName: 'Lakshmi',
        nomineeAge: 32,
        nomineeRelationship: 'Spouse',
        nomineePhone: '9876543210',
      },
      pilgrims: [
        {
          id: 'task-1',
          fullName: 'BASKAR DURAISAMY',
          metadata: { taskIndex: 1, taskStatus: 'PENDING' },
        },
        {
          id: 'task-2',
          fullName: 'GUNA',
          metadata: { taskIndex: 2, taskStatus: 'PENDING' },
        },
      ],
      preferences: {},
    };
  });

  afterEach(() => {
    BookingExecutionGuard.clearAll();
  });

  it('Test 1: Official successful popup + OK + Transaction History navigation marks devotee CONFIRMED', async () => {
    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // completeJob must be called for the devotee
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.objectContaining({
      taskIndex: 1,
      officialReference: 'IVQ261126232212212140',
      portalTransactionReference: '1928818075',
      transactionId: '1928818075',
      cartId: '1928818075',
    }));

    // Must NOT call failJob
    expect(mockApiClient.failJob).not.toHaveBeenCalled();

    // Devotee #1 is now confirmed, 1 devotee remaining => PARTIALLY_COMPLETED
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-confirm-001');
    expect(lifecycle).toBe('PARTIALLY_COMPLETED');
  });

  it('Test 2: Transaction ID equals Cart ID (e.g. 1928818075) does NOT reject confirmation', async () => {
    // Both Cart ID and Transaction ID are identical (as confirmed on live portal for TA-10018)
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: '1928818075',
      officialBookingReference: '1928818075',
      portalTransactionReference: '1928818075',
      transactionId: '1928818075',
      cartId: '1928818075',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Must accept confirmation and NOT enter history reconciliation
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.objectContaining({
      officialReference: '1928818075',
      transactionId: '1928818075',
      cartId: '1928818075',
    }));
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
  });

  it('Test 3: History initially displaying "No Records Found" does NOT downgrade verified confirmation', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ261126232212212140',
      officialBookingReference: 'IVQ261126232212212140',
      portalTransactionReference: '1928818075',
      transactionId: '1928818075',
      cartId: '1928818075',
    });

    // History returns found: false ("No Records Found.")
    mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
      found: false,
      officialStatusFound: 'NOT_FOUND',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Confirmation must remain intact and NOT downgraded to RECONCILIATION_REQUIRED
    expect(mockApiClient.completeJob).toHaveBeenCalled();
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-confirm-001');
    expect(lifecycle).not.toBe('RECONCILIATION_REQUIRED');
  });

  it('Test 3b: History page containing stale cancelled/failed data does NOT reverse confirmed status', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ261126232212212140',
      officialBookingReference: 'IVQ261126232212212140',
      portalTransactionReference: '1928818075',
      transactionId: '1928818075',
      cartId: '1928818075',
    });

    // Stale history returns cancelled/failed status for this date from an older attempt
    mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
      found: false,
      officialStatusFound: 'CANCELLED',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Stale history CANCELLED must NOT reverse the confirmation from the popup & redirect
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.objectContaining({
      officialReference: 'IVQ261126232212212140',
      transactionId: '1928818075',
    }));
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-confirm-001');
    expect(lifecycle).toBe('PARTIALLY_COMPLETED');
  });

  it('Test 3c: History row with zero pilgrims or missing pass reference does NOT reverse confirmation', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: '1928818075',
      officialBookingReference: '1928818075',
      portalTransactionReference: '1928818075',
      transactionId: '1928818075',
      cartId: '1928818075',
    });

    mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
      found: false,
      officialStatusFound: 'ZERO_PILGRIMS',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockApiClient.completeJob).toHaveBeenCalled();
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
    expect(BookingExecutionGuard.getLifecycleState('req-confirm-001')).not.toBe('RECONCILIATION_REQUIRED');
  });

  it('Test 4: Booking ID (IVQ...) and Transaction ID (1928818075) are stored separately without collision', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ261126232212212140',
      officialBookingReference: 'IVQ261126232212212140',
      portalTransactionReference: '1928818075',
      transactionId: '1928818075',
      cartId: '1928818075',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.objectContaining({
      officialBookingReference: 'IVQ261126232212212140',
      transactionId: '1928818075',
      cartId: '1928818075',
      portalTransactionReference: '1928818075',
    }));
  });

  it('Test 5: When official popup does not appear, does NOT mark confirmed and enters safe reconciliation', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: false,
      reconciliationRequired: true,
      message: 'Official booking success popup did not appear after second Proceed. Entering safe reconciliation.',
    });
    mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
      found: false,
      officialStatusFound: 'NOT_FOUND',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // completeJob must NOT be called
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    // Must route to RECONCILIATION_REQUIRED
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.anything());
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-confirm-001');
    expect(lifecycle).toBe('RECONCILIATION_REQUIRED');
  });

  it('Test 6: Navigation failure after popup routes to reconciliation without duplicate submission', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: false,
      reconciliationRequired: true,
      portalTransactionReference: '1928818075',
      message: 'Official success popup detected with Transaction ID 1928818075, but navigation to Transaction History timed out. Requires reconciliation.',
    });
    mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
      found: false,
      officialStatusFound: 'NOT_FOUND',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.objectContaining({
      status: 'RECONCILIATION_REQUIRED',
      errorCode: 'CONFIRMATION_UNVERIFIED',
    }));
  });

  it('Test 7: Confirmed devotee is skipped and next pending devotee is processed on subsequent execution', async () => {
    // Devotee #1 is already confirmed in metadata
    baseJob.pilgrims = [
      {
        id: 'task-1',
        fullName: 'BASKAR DURAISAMY',
        metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ261126232212212140' },
      },
      {
        id: 'task-2',
        fullName: 'GUNA',
        metadata: { taskIndex: 2, taskStatus: 'PENDING' },
      },
    ];

    let passedDevotee: any = null;
    mockAdapter.selectSingleSavedPilgrim = jest.fn().mockImplementation(async (ctx: any) => {
      passedDevotee = ctx.targetDevotee;
      return {
        success: true,
        selectedPilgrim: { fullName: 'GUNA', identityFingerprint: 'fp_guna_2' },
      };
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Devotee #2 (GUNA) must be selected, NOT Devotee #1
    expect(passedDevotee).not.toBeNull();
    expect(passedDevotee.fullName).toBe('GUNA');
    expect(passedDevotee.sequence).toBe(2);

    // completeJob called for task-2
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.objectContaining({
      taskIndex: 2,
      isFinalPilgrim: true,
    }));

    // All devotees now confirmed => BOOKING_CONFIRMED
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-confirm-001');
    expect(lifecycle).toBe('BOOKING_CONFIRMED');
  });

  it('Test 8: SabarimalaPostLoginFlow.executePaymentProceedAndConfirm captures popup + auto-navigates cleanly', async () => {
    let clickedOk = false;
    const mockPage: any = {
      innerText: jest.fn().mockImplementation(async (sel: string) => {
        if (sel === 'body') {
          return 'Welcome | BASKAR\nPayment Description\nCart ID : 1928818075\nBooking ID IVQ261126232212212140 Clean Sabarimala Fund ₹0.00 Amount ₹0.00';
        }
        return '';
      }),
      screenshot: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockImplementation(async () => {
        currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
      }),
      url: jest.fn().mockImplementation(() => currentUrl),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Proceed') || sel.includes('button')) {
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(true),
              click: jest.fn().mockImplementation(async () => {
                clickedOk = true;
              }),
            }),
          };
        }
        if (sel.includes('Booking Confirmation') || sel.includes('mat-dialog-container') || sel.includes('swal2')) {
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(true),
              innerText: jest.fn().mockResolvedValue(
                'Booking Confirmation\nYour transaction is successful with Transaction ID:1928818075.\nClick OK to download the receipts from Transaction History.\nPlease rate Us: Excellent Good Needs Improvement\nOK'
              ),
              locator: jest.fn().mockReturnValue({
                first: () => ({
                  isVisible: jest.fn().mockResolvedValue(true),
                  click: jest.fn().mockImplementation(async () => {
                    clickedOk = true;
                    currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
                  }),
                }),
              }),
            }),
          };
        }
        return {
          first: () => ({
            isVisible: jest.fn().mockResolvedValue(false),
            count: jest.fn().mockResolvedValue(0),
          }),
          count: jest.fn().mockResolvedValue(0),
        };
      }),
    };

    let currentUrl = 'https://sabarimalaonline.org/#/paymentGateway';
    const ctx: any = {
      bookingCode: 'TA-10018',
      requestedDate: '2026-11-27',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    };

    const res = await SabarimalaPostLoginFlow.executePaymentProceedAndConfirm(mockPage, ctx);

    expect(res.confirmed).toBe(true);
    expect(res.transactionId).toBe('1928818075');
    expect(res.officialBookingReference).toBe('IVQ261126232212212140');
    expect(res.cartId).toBe('1928818075');
  });

  it('Test 9: executePaymentProceedAndConfirm remains CONFIRMED even if Transaction History page text has "No Records Found" or stale CANCELLED text', async () => {
    let currentUrl = 'https://sabarimalaonline.org/#/paymentGateway';
    const mockPage: any = {
      innerText: jest.fn().mockImplementation(async (sel: string) => {
        if (sel === 'body') {
          if (currentUrl.includes('TransactionHistory')) {
            return 'Transaction History\nSelect Service * All\nNo Records Found.\nPrevious transaction CANCELLED 0 pilgrims';
          }
          return 'Welcome | BASKAR\nPayment Description\nCart ID : 1928818361\nBooking ID IVQ261127010233327190 Clean Sabarimala Fund ₹0.00 Amount ₹0.00';
        }
        return '';
      }),
      screenshot: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockImplementation(async () => {
        currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
      }),
      url: jest.fn().mockImplementation(() => currentUrl),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Proceed') || sel.includes('button')) {
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(true),
              click: jest.fn().mockResolvedValue(undefined),
            }),
          };
        }
        if (sel.includes('Booking Confirmation') || sel.includes('mat-dialog-container') || sel.includes('swal2')) {
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(true),
              innerText: jest.fn().mockResolvedValue(
                'Booking Confirmation\nYour transaction is successful with Transaction ID:1928818361.\nClick OK to download the receipts from Transaction History.\nOK'
              ),
              locator: jest.fn().mockReturnValue({
                first: () => ({
                  isVisible: jest.fn().mockResolvedValue(true),
                  click: jest.fn().mockImplementation(async () => {
                    currentUrl = 'https://sabarimalaonline.org/#/TransactionHistory';
                  }),
                }),
              }),
            }),
          };
        }
        return {
          first: () => ({
            isVisible: jest.fn().mockResolvedValue(false),
            count: jest.fn().mockResolvedValue(0),
          }),
          count: jest.fn().mockResolvedValue(0),
        };
      }),
    };

    const ctx: any = {
      bookingCode: 'TA-10027',
      requestedDate: '2026-11-28',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    };

    const res = await SabarimalaPostLoginFlow.executePaymentProceedAndConfirm(mockPage, ctx);

    // Must be confirmed, and must NOT be reversed by "No Records Found" or stale cancelled text
    expect(res.confirmed).toBe(true);
    expect(res.transactionId).toBe('1928818361');
    expect(res.officialBookingReference).toBe('IVQ261127010233327190');
    expect(res.cartId).toBe('1928818361');
  });

  it('Test 10: Confirmation persistence and execution lock release happen correctly', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ261127010233327190',
      officialBookingReference: 'IVQ261127010233327190',
      portalTransactionReference: '1928818361',
      transactionId: '1928818361',
      cartId: '1928818361',
      confirmedAt: '2026-11-26T19:32:42.000Z',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // 1. Persistence via completeJob
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-confirm-evidence-001', expect.objectContaining({
      officialReference: 'IVQ261127010233327190',
      officialBookingReference: 'IVQ261127010233327190',
      transactionId: '1928818361',
      cartId: '1928818361',
      confirmedAt: '2026-11-26T19:32:42.000Z',
      taskIndex: 1,
    }));

    // 2. Lock is completely released after execution
    expect(BookingExecutionGuard.isBookingActive('req-confirm-001')).toBe(false);
  });
});
