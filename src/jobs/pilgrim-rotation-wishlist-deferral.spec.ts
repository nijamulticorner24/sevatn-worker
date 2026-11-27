import { BookingWorker } from './booking-worker';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { SanitizedLogger } from '../monitoring/logger';
import { BookingExecutionGuard } from '../security/execution-guard';
import { TelegramFailureNotifier } from '../monitoring/telegram-notifier';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

describe('Automatic Pilgrim Rotation After Wishlist Failure', () => {
  let infoLogs: string[] = [];
  let warnLogs: string[] = [];
  let errorLogs: string[] = [];

  const baseNominee = {
    nomineeName: 'Test Nominee',
    nomineeAge: 45,
    nomineeRelationship: 'FATHER',
    nomineePhone: '9876543210',
  };

  const accountData = {
    id: 'acc-rot-1',
    username: 'sabarimala_user_rot',
    encryptedPassword: 'enc:pass',
    encryptionIv: 'iv:mock',
    encryptionTag: 'tag:mock',
  };

  beforeEach(() => {
    BookingExecutionGuard.clearAll();
    TelegramFailureNotifier.clearCache();
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
    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
  });

  afterEach(() => {
    BookingExecutionGuard.clearAll();
    jest.restoreAllMocks();
  });

  function createBaseMockAdapter(overrides: Record<string, any> = {}) {
    return {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => ({
        success: true,
        selectedPilgrim: { fullName: ctx.targetDevotee?.fullName || 'Pilgrim', identityFingerprint: `fp_${ctx.targetDevotee?.sequence || 1}` },
      })),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814001',
      }),
      checkExistingBookingInHistory: jest.fn().mockResolvedValue({ found: false }),
      captureScreenshotBase64: jest.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  // 1. Wishlist restriction on P1 defers P1 and selects P2 on the next fresh availability event
  it('1. Wishlist restriction on P1 defers P1 and selects P2 on the next fresh availability event', async () => {
    let attemptedPilgrim: any = null;
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        attemptedPilgrim = ctx.targetDevotee;
        return { success: true, selectedPilgrim: { fullName: ctx.targetDevotee?.fullName, identityFingerprint: 'fp_1' } };
      }),
      addToWishlistAndVerify: jest.fn().mockRejectedValue(
        new Error('You are already having Pending Booking(s) for the Same Slot / Sufficient Quota is not available for the selected No.of Pilgrims'),
      ),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim One', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
      { id: 'p-2', fullName: 'Pilgrim Two', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
    ];

    const jobEvent1: any = {
      id: 'job-rot-1',
      bookingCode: 'TA-ROT-001',
      leaseGeneration: 1,
      fencingToken: 'fence-1',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 2,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    };

    // Event 1: P1 is attempted and fails at Wishlist
    await worker.execute(jobEvent1);

    expect(attemptedPilgrim.fullName).toBe('Pilgrim One');
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-rot-1',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        taskIndex: 1,
        pilgrimTaskId: 'p-1',
      }),
    );
    expect(warnLogs.some((l) => l.includes('[PILGRIM-ROTATION-DEFERRED]') && l.includes('devoteeSequence=1'))).toBe(true);

    // Event 2: Fresh availability event. Adapter succeeds for P2
    mockAdapter.addToWishlistAndVerify = jest.fn().mockResolvedValue(true);

    const jobEvent2: any = {
      ...jobEvent1,
      leaseGeneration: 2,
      fencingToken: 'fence-2',
      // pilgrims contains P1 with deferred metadata and unattempted P2
      pilgrims,
    };

    await worker.execute(jobEvent2);

    expect(attemptedPilgrim.fullName).toBe('Pilgrim Two');
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-rot-1',
      expect.objectContaining({
        taskIndex: 2,
      }),
    );
  });

  // 2. Missing Wishlist side drawer defers the current pilgrim
  it('2. Missing Wishlist side drawer defers the current pilgrim', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Wishlist drawer not found or could not be opened after Add to Wishlist',
        errorCode: 'WISHLIST_DRAWER_NOT_FOUND',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim One', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
      { id: 'p-2', fullName: 'Pilgrim Two', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
    ];

    const job: any = {
      id: 'job-drawer-miss',
      bookingCode: 'TA-DRAWER-MISS',
      leaseGeneration: 1,
      fencingToken: 'fence-dm',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 2,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    };

    await worker.execute(job);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-drawer-miss',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        taskIndex: 1,
      }),
    );
    expect(warnLogs.some((l) => l.includes('[PILGRIM-ROTATION-DEFERRED]') && l.includes('devoteeSequence=1'))).toBe(true);
    expect(pilgrims[0].metadata).toEqual(
      expect.objectContaining({
        deferralCount: 1,
        taskStatus: 'PENDING',
      }),
    );
  });

  // 3. Any final Wishlist click error defers the current pilgrim
  it('3. Any final Wishlist click error defers the current pilgrim', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Portal network error during Wishlist submission',
        errorCode: 'WISHLIST_INSERTION_FAILED',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim One', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    const job: any = {
      id: 'job-click-err',
      bookingCode: 'TA-CLICK-ERR',
      leaseGeneration: 1,
      fencingToken: 'fence-ce',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    };

    await worker.execute(job);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-click-err',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        taskIndex: 1,
      }),
    );
    expect(warnLogs.some((l) => l.includes('[PILGRIM-ROTATION-DEFERRED]'))).toBe(true);
  });

  // 4. Rotation order persists after worker restart / job re-claim
  it('4. Rotation order persists after worker restart / job re-claim', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    let selectedDevotee: any = null;
    const mockAdapter = createBaseMockAdapter({
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedDevotee = ctx.targetDevotee;
        return { success: true, selectedPilgrim: { fullName: ctx.targetDevotee?.fullName, identityFingerprint: 'fp' } };
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    // Simulate persistent database payload fetched after container restart:
    // P1 was deferred 2 minutes ago, P2 was deferred 1 minute ago, P3 is unattempted
    const persistedPilgrims = [
      {
        id: 'p-1',
        fullName: 'Pilgrim One',
        metadata: {
          taskIndex: 1,
          taskStatus: 'PENDING',
          deferredAt: new Date(Date.now() - 120000).toISOString(),
          deferralCount: 1,
        },
      },
      {
        id: 'p-2',
        fullName: 'Pilgrim Two',
        metadata: {
          taskIndex: 2,
          taskStatus: 'PENDING',
          deferredAt: new Date(Date.now() - 60000).toISOString(),
          deferralCount: 1,
        },
      },
      {
        id: 'p-3',
        fullName: 'Pilgrim Three',
        metadata: {
          taskIndex: 3,
          taskStatus: 'PENDING',
        },
      },
    ];

    // New worker instance
    const freshWorker = new BookingWorker(mockApiClient);

    const reClaimedJob: any = {
      id: 'job-reclaimed',
      bookingCode: 'TA-RESTART',
      leaseGeneration: 3,
      fencingToken: 'fence-restart',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: persistedPilgrims,
    };

    await freshWorker.execute(reClaimedJob);

    // Unattempted P3 must be selected first
    expect(selectedDevotee.fullName).toBe('Pilgrim Three');
    expect(selectedDevotee.sequence).toBe(3);
  });

  // 5. Full P1 -> P2 -> P3 -> P4 -> P5 -> P1 rotation works
  it('5. Full P1 -> P2 -> P3 -> P4 -> P5 -> P1 rotation works across availability cycles', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const attemptedSequences: number[] = [];

    const mockAdapter = createBaseMockAdapter({
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        attemptedSequences.push(ctx.targetDevotee.sequence);
        return { success: true, selectedPilgrim: { fullName: ctx.targetDevotee.fullName, identityFingerprint: `fp_${ctx.targetDevotee.sequence}` } };
      }),
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Sufficient Quota is not available',
        errorCode: 'PREVIOUS_BOOKING_RESTRICTION',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
      { id: 'p-2', fullName: 'Pilgrim 2', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
      { id: 'p-3', fullName: 'Pilgrim 3', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      { id: 'p-4', fullName: 'Pilgrim 4', metadata: { taskIndex: 4, taskStatus: 'PENDING' } },
      { id: 'p-5', fullName: 'Pilgrim 5', metadata: { taskIndex: 5, taskStatus: 'PENDING' } },
    ];

    const baseJob: any = {
      id: 'job-5-rot',
      bookingCode: 'TA-5-ROT',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 5,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    };

    // Cycle 1: Expect P1
    await worker.execute({ ...baseJob, leaseGeneration: 1, fencingToken: 'f-1' });
    // Cycle 2: Expect P2
    await worker.execute({ ...baseJob, leaseGeneration: 2, fencingToken: 'f-2' });
    // Cycle 3: Expect P3
    await worker.execute({ ...baseJob, leaseGeneration: 3, fencingToken: 'f-3' });
    // Cycle 4: Expect P4
    await worker.execute({ ...baseJob, leaseGeneration: 4, fencingToken: 'f-4' });
    // Cycle 5: Expect P5
    await worker.execute({ ...baseJob, leaseGeneration: 5, fencingToken: 'f-5' });
    // Cycle 6: After all 5 have failed once, queue loops back to P1!
    await worker.execute({ ...baseJob, leaseGeneration: 6, fencingToken: 'f-6' });

    expect(attemptedSequences).toEqual([1, 2, 3, 4, 5, 1]);
  });

  // 6. Only one pilgrim is attempted per fresh availability event
  it('6. Only one pilgrim is attempted per fresh availability event', async () => {
    let selectPilgrimCalls = 0;
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async () => {
        selectPilgrimCalls++;
        return { success: true, selectedPilgrim: { fullName: 'P1', identityFingerprint: 'fp_1' } };
      }),
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Quota full',
        errorCode: 'WISHLIST_DRAWER_NOT_FOUND',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
      { id: 'p-2', fullName: 'Pilgrim 2', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-one-attempt',
      bookingCode: 'TA-ONE-ATTEMPT',
      leaseGeneration: 1,
      fencingToken: 'f-oa',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 2,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    // Exactly 1 selection attempt was made
    expect(selectPilgrimCalls).toBe(1);
    expect(mockAdapter.logout).toHaveBeenCalledTimes(1);
  });

  // 7. Confirmed pilgrims are never selected again
  it('7. Confirmed pilgrims are never selected again', async () => {
    let selectedDevotee: any = null;
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedDevotee = ctx.targetDevotee;
        return { success: true, selectedPilgrim: { fullName: ctx.targetDevotee.fullName, identityFingerprint: `fp_${ctx.targetDevotee.sequence}` } };
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      {
        id: 'p-1',
        fullName: 'Pilgrim 1',
        metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: 'REF12345' },
      },
      {
        id: 'p-2',
        fullName: 'Pilgrim 2',
        metadata: { taskIndex: 2, taskStatus: 'PENDING', deferralCount: 2 },
      },
    ];

    await worker.execute({
      id: 'job-confirmed-excl',
      bookingCode: 'TA-CONF-EXCL',
      leaseGeneration: 1,
      fencingToken: 'f-ce',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 2,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    // P1 was confirmed, so P2 was selected despite having deferrals
    expect(selectedDevotee.fullName).toBe('Pilgrim 2');
    expect(selectedDevotee.sequence).toBe(2);
  });

  // 8. Deferred pilgrims remain pending and are not marked confirmed
  it('8. Deferred pilgrims remain pending and are not marked confirmed', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Wishlist quota error',
        errorCode: 'WISHLIST_DEFERRED',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-pending-check',
      bookingCode: 'TA-PEND-CHECK',
      leaseGeneration: 1,
      fencingToken: 'f-pc',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    expect((pilgrims[0].metadata as any).taskStatus).toBe('PENDING');
    expect((pilgrims[0].metadata as any).deferralCount).toBe(1);
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  // 9. Telegram failure does not stop rotation or monitoring
  it('9. Telegram failure does not stop rotation or monitoring', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Wishlist failure',
        errorCode: 'WISHLIST_DRAWER_NOT_FOUND',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    // Mock Telegram notifier to throw an unexpected network exception
    jest.spyOn(TelegramFailureNotifier, 'sendFailureAlert').mockRejectedValue(new Error('Telegram API connection timeout'));

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    // Execution must complete gracefully without throwing unhandled rejection
    await expect(worker.execute({
      id: 'job-tg-fail',
      bookingCode: 'TA-TG-FAIL',
      leaseGeneration: 1,
      fencingToken: 'f-tg',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any)).resolves.not.toThrow();

    // Central API report was still delivered and devotee was deferred
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-tg-fail',
      expect.objectContaining({ status: 'TEMPORARY_SLOT_LOST' }),
    );
    expect((pilgrims[0].metadata as any).deferralCount).toBe(1);
  });

  // 10. No Wishlist-stage deferral creates RECONCILIATION_REQUIRED or an admin action requirement
  it('10. No Wishlist-stage deferral creates RECONCILIATION_REQUIRED or an admin action requirement', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Sufficient Quota is not available for the selected No.of Pilgrims',
        errorCode: 'PREVIOUS_BOOKING_RESTRICTION',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-no-recon',
      bookingCode: 'TA-NO-RECON',
      leaseGeneration: 1,
      fencingToken: 'f-nr',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    // Must NOT be RECONCILIATION_REQUIRED or REQUIRES_HUMAN
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-no-recon',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
      }),
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalledWith(
      'job-no-recon',
      expect.objectContaining({
        status: 'RECONCILIATION_REQUIRED',
      }),
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalledWith(
      'job-no-recon',
      expect.objectContaining({
        status: 'REQUIRES_HUMAN',
      }),
    );
  });

  // 11. Successful Wishlist drawer appearance continues the existing successful flow unchanged
  it('11. Successful Wishlist drawer appearance continues the existing successful flow unchanged', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814777',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-success-flow',
      bookingCode: 'TA-SUCCESS',
      leaseGeneration: 1,
      fencingToken: 'f-succ',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    expect(mockAdapter.proceedToPaymentGateway).toHaveBeenCalledTimes(1);
    expect(mockAdapter.executePaymentProceedAndConfirm).toHaveBeenCalledTimes(1);
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-success-flow',
      expect.objectContaining({
        officialReference: '1928814777',
        isFinalPilgrim: true,
      }),
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
  });

  // 12. Locks are released and the job returns to monitoring after deferral
  it('12. Locks are released and the job returns to monitoring after deferral', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'Wishlist error',
        errorCode: 'WISHLIST_DRAWER_NOT_FOUND',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    const bookingKey = 'req-ta-lock-test';
    await worker.execute({
      id: 'job-lock-test',
      bookingRequestId: bookingKey,
      bookingCode: 'TA-LOCK-TEST',
      leaseGeneration: 1,
      fencingToken: 'f-lock',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    // Active lock in BookingExecutionGuard must be released
    const activeLock = BookingExecutionGuard.getActiveLock(bookingKey);
    expect(activeLock).toBeUndefined();

    // Adapter logout and close were called to free browser context
    expect(mockAdapter.logout).toHaveBeenCalledTimes(1);
    expect(mockAdapter.close).toHaveBeenCalledTimes(1);
  });

  // 13. Final Wishlist BUTTON_DISABLED causes automatic deferral and not manual review
  it('13. Final Wishlist BUTTON_DISABLED causes automatic deferral and not manual review', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'BUTTON_DISABLED: Add to Wishlist button (#regi_continue) is disabled. Reason: Slot selection unconfirmed on portal',
        errorCode: 'BUTTON_DISABLED',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
      { id: 'p-2', fullName: 'Pilgrim 2', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-btn-disabled',
      bookingCode: 'TA-BTN-DISABLED',
      leaseGeneration: 1,
      fencingToken: 'f-bd',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 2,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-btn-disabled',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        taskIndex: 1,
        pilgrimTaskId: 'p-1',
      }),
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalledWith(
      'job-btn-disabled',
      expect.objectContaining({
        status: 'REQUIRES_HUMAN',
      }),
    );
    expect((pilgrims[0].metadata as any).taskStatus).toBe('PENDING');
    expect((pilgrims[0].metadata as any).deferralCount).toBe(1);
    expect(warnLogs.some((l) => l.includes('[PILGRIM-ROTATION-DEFERRED]') && l.includes('devoteeSequence=1'))).toBe(true);
  });

  // 14. WISHLIST_DATA_MISMATCH with no authoritative confirmation causes automatic deferral
  it('14. WISHLIST_DATA_MISMATCH with no authoritative confirmation causes automatic deferral', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'WISHLIST_DATA_MISMATCH: Expected date 28/11/2026 not found in Wishlist',
        errorCode: 'WISHLIST_DATA_MISMATCH',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
      checkExistingBookingInHistory: jest.fn().mockResolvedValue({ found: false }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-mismatch-unconfirmed',
      bookingCode: 'TA-MISMATCH-UNCONF',
      leaseGeneration: 1,
      fencingToken: 'f-mu',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-mismatch-unconfirmed',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        taskIndex: 1,
        pilgrimTaskId: 'p-1',
      }),
    );
    expect((pilgrims[0].metadata as any).taskStatus).toBe('PENDING');
    expect((pilgrims[0].metadata as any).deferralCount).toBe(1);
    expect(warnLogs.some((l) => l.includes('[PILGRIM-ROTATION-DEFERRED]'))).toBe(true);
  });

  // 15. WISHLIST_DATA_MISMATCH with authoritative confirmation marks the pilgrim confirmed and does not defer them
  it('15. WISHLIST_DATA_MISMATCH with authoritative confirmation marks the pilgrim confirmed and does not defer them', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'WISHLIST_DATA_MISMATCH: Expected date 28/11/2026 not found in Wishlist',
        errorCode: 'WISHLIST_DATA_MISMATCH',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
      checkExistingBookingInHistory: jest.fn().mockResolvedValue({
        found: true,
        officialReference: '1928819999',
        status: 'CONFIRMED',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-mismatch-confirmed',
      bookingCode: 'TA-MISMATCH-CONF',
      leaseGeneration: 1,
      fencingToken: 'f-mc',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    // Pilgrim must be completed, NOT failed or deferred
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-mismatch-confirmed',
      expect.objectContaining({
        officialReference: '1928819999',
        taskIndex: 1,
      }),
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
    expect((pilgrims[0].metadata as any).deferralCount).toBeUndefined();
  });

  // 16. Both failure cases capture and dispatch screenshot notifications
  it('16. Both failure cases capture and dispatch screenshot notifications', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const alertSpy = jest.spyOn(TelegramFailureNotifier, 'sendFailureAlert');

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'BUTTON_DISABLED: Add to Wishlist button (#regi_continue) is disabled.',
        errorCode: 'BUTTON_DISABLED',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
      captureScreenshotBase64: jest.fn().mockResolvedValue('data:image/png;base64,mockedButtonDisabledScreenshot'),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-screenshot-alert',
      bookingCode: 'TA-SCREENSHOT-ALERT',
      leaseGeneration: 1,
      fencingToken: 'f-sa',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    expect(mockAdapter.captureScreenshotBase64).toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingCode: 'TA-SCREENSHOT-ALERT',
        screenshotBase64: 'data:image/png;base64,mockedButtonDisabledScreenshot',
        devoteeSequence: 1,
      }),
    );
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-screenshot-alert',
      expect.objectContaining({
        screenshot: 'data:image/png;base64,mockedButtonDisabledScreenshot',
      }),
    );
  });

  // 17. Both cases release locks and resume monitoring
  it('17. Both cases release locks and resume monitoring', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'WISHLIST_DATA_MISMATCH: Drawer did not appear',
        errorCode: 'WISHLIST_DATA_MISMATCH',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    const bookingKey = 'req-ta-gap-lock';
    await worker.execute({
      id: 'job-gap-lock',
      bookingRequestId: bookingKey,
      bookingCode: 'TA-GAP-LOCK',
      leaseGeneration: 1,
      fencingToken: 'f-gl',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    expect(BookingExecutionGuard.getActiveLock(bookingKey)).toBeUndefined();
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
  });

  // 18. Neither case triggers an admin-action or reconciliation status
  it('18. Neither case triggers an admin-action or reconciliation status', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter = createBaseMockAdapter({
      addToWishlistAndVerify: jest.fn().mockRejectedValue({
        message: 'BUTTON_DISABLED: Add to Wishlist button (#regi_continue) is disabled',
        errorCode: 'BUTTON_DISABLED',
        flowPhase: 'PHASE_7_WISHLIST',
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-no-admin',
      bookingCode: 'TA-NO-ADMIN',
      leaseGeneration: 1,
      fencingToken: 'f-na',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    expect(mockApiClient.failJob).not.toHaveBeenCalledWith(
      'job-no-admin',
      expect.objectContaining({ status: 'RECONCILIATION_REQUIRED' }),
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalledWith(
      'job-no-admin',
      expect.objectContaining({ status: 'REQUIRES_HUMAN' }),
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalledWith(
      'job-no-admin',
      expect.objectContaining({ status: 'MANUAL_REVIEW' }),
    );
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-no-admin',
      expect.objectContaining({ status: 'TEMPORARY_SLOT_LOST' }),
    );
  });

  // 19. Earlier unrelated form validation errors retain their existing behavior
  it('19. Earlier unrelated form validation errors retain their existing behavior', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    // Simulate earlier form validation error (e.g. during nominee populating)
    const mockAdapter = createBaseMockAdapter({
      populateNomineeDetails: jest.fn().mockRejectedValue({
        message: 'BUTTON_DISABLED: Form validation error on nominee submission',
        errorCode: 'FORM_VALIDATION_ERROR',
        // flowPhase is NOT PHASE_7_WISHLIST
      }),
    });
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const pilgrims = [
      { id: 'p-1', fullName: 'Pilgrim 1', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
    ];

    await worker.execute({
      id: 'job-earlier-validation',
      bookingCode: 'TA-EARLIER-VALID',
      leaseGeneration: 1,
      fencingToken: 'f-ev',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      pilgrimCount: 1,
      nominee: baseNominee,
      account: accountData,
      pilgrims,
    } as any);

    // Unrelated earlier error MUST retain REQUIRES_HUMAN (manual review)
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-earlier-validation',
      expect.objectContaining({
        status: 'REQUIRES_HUMAN',
        errorCode: 'FORM_VALIDATION_ERROR',
      }),
    );
    // Deferral count must NOT be incremented for this earlier validation failure
    expect((pilgrims[0].metadata as any).deferralCount).toBeUndefined();
  });
});
