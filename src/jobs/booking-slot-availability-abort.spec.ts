import { BookingWorker } from './booking-worker';
import { BookingExecutionGuard } from '../security/execution-guard';
import { SabarimalaPostLoginFlow } from '../sabarimala/post-login-flow';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';

jest.mock('../sabarimala/sabarimala-adapter');

describe('Booking Flow — Slot Availability Abort & No Post-Login Reselection Regression Suite', () => {
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
        officialReference: '1928814227',
      }),
      logout: jest.fn().mockResolvedValue(true),
      captureScreenshotBase64: jest.fn().mockResolvedValue('mock-screenshot-base64'),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    baseJob = {
      id: 'job-slot-abort-001',
      bookingRequestId: 'req-slot-abort-001',
      bookingCode: 'TA-10018',
      requestedDate: '2026-11-27',
      route: 'Pamba - Marakkoottam - 4 Kms',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 1,
      leaseGeneration: 1,
      fencingToken: 'fnc_slot_abort_001',
      account: {
        id: 'acc-slot-01',
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
          id: 'pilgrim-task-1',
          fullName: 'BASKAR DURAISAMY',
          metadata: { taskIndex: 1, taskStatus: 'PENDING' },
        },
      ],
      preferences: {},
    };
  });

  afterEach(() => {
    BookingExecutionGuard.clearAll();
  });

  it('Requirement 1 & 2: Date and route selected before login, and never re-selected after login', async () => {
    const callSequence: string[] = [];

    mockAdapter.openDarshanAvailability = jest.fn().mockImplementation(async () => {
      callSequence.push('openDarshanAvailability');
      return { success: true };
    });
    mockAdapter.selectRequestedDate = jest.fn().mockImplementation(async () => {
      callSequence.push('selectRequestedDate');
      return { success: true };
    });
    mockAdapter.selectRoute = jest.fn().mockImplementation(async () => {
      callSequence.push('selectRoute');
      return true;
    });
    mockAdapter.proceedToLogin = jest.fn().mockImplementation(async () => {
      callSequence.push('proceedToLogin');
      return true;
    });
    mockAdapter.login = jest.fn().mockImplementation(async () => {
      callSequence.push('login');
      return { status: 'LOGIN_SUCCESS' };
    });
    mockAdapter.verifyCarriedDateAndRoute = jest.fn().mockImplementation(async () => {
      callSequence.push('verifyCarriedDateAndRoute');
      return true;
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Verify sequence: Date and route are selected BEFORE login
    const dateIdx = callSequence.indexOf('selectRequestedDate');
    const routeIdx = callSequence.indexOf('selectRoute');
    const loginBtnIdx = callSequence.indexOf('proceedToLogin');
    const loginIdx = callSequence.indexOf('login');
    const verifyIdx = callSequence.indexOf('verifyCarriedDateAndRoute');

    expect(dateIdx).toBeGreaterThanOrEqual(0);
    expect(routeIdx).toBeGreaterThan(dateIdx);
    expect(loginBtnIdx).toBeGreaterThan(routeIdx);
    expect(loginIdx).toBeGreaterThan(loginBtnIdx);
    expect(verifyIdx).toBeGreaterThan(loginIdx);

    // selectRequestedDate and selectRoute must NOT be called again after login
    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledTimes(1);
    expect(mockAdapter.selectRoute).toHaveBeenCalledTimes(1);
  });

  it('Requirement 2b: If portal lost carried date or route after login, safely aborts without force-reselecting', async () => {
    mockAdapter.verifyCarriedDateAndRoute = jest.fn().mockRejectedValue(
      new Error('CARRIED_DATE_LOST: Date input on #/darshan is empty after login. Aborting safely without post-login reselection.')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Must log out immediately
    expect(mockAdapter.logout).toHaveBeenCalled();

    // Must report TEMPORARY_SLOT_LOST / retryable failure
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-slot-abort-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'MISMATCHED_DATE',
    }));

    // Must NOT proceed to slot selection or pilgrim submission
    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).not.toHaveBeenCalled();
    expect(mockAdapter.selectSingleSavedPilgrim).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  it('Requirement 3: When slot cards are missing, captures screenshot, immediately aborts without reload or retry, and never submits pilgrims', async () => {
    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockRejectedValue(
      new Error('SLOT_CARDS_MISSING: No slot cards rendered on authenticated booking page')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Must be called with maxRefreshes=0 (strict single check)
    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).toHaveBeenCalledWith(expect.any(Object), 0);

    // Must log out
    expect(mockAdapter.logout).toHaveBeenCalled();

    // Must report fail with SLOT_CARDS_MISSING
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-slot-abort-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'SLOT_CARDS_MISSING',
    }));

    // Must NOT submit any pilgrim or call completeJob
    expect(mockAdapter.selectSingleSavedPilgrim).not.toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    // Devotee must NOT be marked confirmed
    const pilgrim = baseJob.pilgrims[0];
    expect(pilgrim.metadata.taskStatus).toBe('PENDING');
  });

  it('Requirement 4: PostLoginFlow.verifyCarriedDateAndRoute fails closed when date or route is blank without re-selecting', async () => {
    const makeMockPage = (dateVal: string, routeText: string) => ({
      locator: jest.fn().mockImplementation(() => ({
        first: () => ({
          isVisible: jest.fn().mockResolvedValue(true),
          inputValue: jest.fn().mockResolvedValue(dateVal),
          evaluate: jest.fn().mockResolvedValue(routeText),
        }),
      })),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    });

    const ctx: any = {
      bookingCode: 'TA-10018',
      requestedDate: '2026-11-27',
      requestedDateDisplay: '27-11-2026',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    };

    // When date is blank: throws CARRIED_DATE_LOST
    await expect(
      SabarimalaPostLoginFlow.verifyCarriedDateAndRoute(makeMockPage('', 'Pamba - Marakkoottam - 4 Kms') as any, ctx)
    ).rejects.toThrow(/CARRIED_DATE_LOST/);

    // When route is unselected: throws CARRIED_ROUTE_LOST
    await expect(
      SabarimalaPostLoginFlow.verifyCarriedDateAndRoute(makeMockPage('27-11-2026', 'Select Route') as any, ctx)
    ).rejects.toThrow(/CARRIED_ROUTE_LOST/);
  });

  it('Requirement 5: Priority lock release & demand key preservation upon retryable failure', async () => {
    const key = '2026-11-27:Pamba';
    const lockRes = BookingExecutionGuard.acquireGlobalPriorityLock({
      demandKey: key,
      date: '2026-11-27',
      route: 'Pamba',
      bookingId: 'req-slot-abort-001',
    });
    expect(lockRes.acquired).toBe(true);
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(true);

    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockRejectedValue(
      new Error('SLOT_CARDS_MISSING: No slot cards rendered on authenticated booking page')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Priority lock can be released safely
    BookingExecutionGuard.releaseGlobalPriorityLock(key);
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);

    // Lifecycle state was updated to TEMPORARY_SLOT_LOST (never SUCCESS)
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-slot-abort-001');
    expect(lifecycle).toBe('TEMPORARY_SLOT_LOST');
    expect(lifecycle).not.toBe('BOOKING_CONFIRMED');
    expect(lifecycle).not.toBe('SUCCESS');
  });
});
