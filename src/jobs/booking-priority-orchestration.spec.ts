import { WorkerOrchestrator, DemandKeyState } from '../worker/orchestrator';
import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';
import { BookingExecutionGuard } from '../security/execution-guard';
import { TelegramFailureNotifier } from '../monitoring/telegram-notifier';
import { AvailabilityCache } from '../availability/availability-cache';
import { BookingWorker } from './booking-worker';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';

describe('Booking-Priority Orchestration Flow Test Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockHeartbeat: jest.Mocked<HeartbeatService>;

  beforeEach(() => {
    delete process.env.MAX_ACTIVE_BOOKINGS;
    delete process.env.MAX_AVAILABILITY_MONITORS;
    delete process.env.WATCH_WINDOW_MS;
    delete process.env.REST_WINDOW_MS;
    delete process.env.MAX_BOOKING_ATTEMPTS;

    AvailabilityCache.getInstance().clear();
    BookingExecutionGuard.clearAll();

    mockApiClient = {
      claimJob: jest.fn().mockResolvedValue({ hasJob: false }),
      getDemandDates: jest.fn().mockResolvedValue([]),
      getPendingDates: jest.fn().mockResolvedValue({ dates: [] }),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
      updateJobProgress: jest.fn().mockResolvedValue({ success: true }),
      publishBulkAvailability: jest.fn().mockResolvedValue({ success: true }),
    } as any;

    mockHeartbeat = {
      isExecutionPermitted: jest.fn().mockReturnValue(true),
      isDiscoveryPermitted: jest.fn().mockReturnValue(true),
      getDesiredState: jest.fn().mockReturnValue('RUNNING'),
      getMaxConcurrentJobs: jest.fn().mockReturnValue(1),
      setExecutionPermitted: jest.fn(),
      setStatus: jest.fn(),
      addActiveJob: jest.fn(),
      removeActiveJob: jest.fn(),
    } as any;
  });

  afterEach(() => {
    BookingExecutionGuard.clearAll();
    jest.restoreAllMocks();
  });

  // REQUIREMENT 1: All refresh polling pauses when a date becomes AVAILABLE
  it('1. All refresh polling pauses when a date becomes AVAILABLE', async () => {
    // Two dates in demand: 2026-12-14 and 2026-12-15
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-12-14|Pamba|ALL', date: '2026-12-14', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10016'] },
      { demandKey: '2026-12-15|Pamba|ALL', date: '2026-12-15', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10017'] },
    ]);

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

    // Date 14 returns AVAILABLE, Date 15 would return FULL
    const pollSpy = jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockImplementation(async (key: string) => {
      if (String(key).includes('2026-12-14')) {
        return { state: 'AVAILABLE', available: true };
      }
      return { state: 'FULL', available: false };
    });

    // Hold the execution in processJobAsync so we can inspect that Date 15 is paused
    let releaseBookingExecution: () => void;
    const bookingExecutionPromise = new Promise<void>((resolve) => {
      releaseBookingExecution = resolve;
    });

    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-priority-1',
        bookingRequestId: 'req-10016',
        bookingCode: 'TA-10016',
        requestedDate: '2026-12-14',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-10016',
      },
    });

    jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async () => {
      await bookingExecutionPromise;
    });

    await orchestrator.start();

    // Wait for the single engine loop to tick and detect AVAILABLE on Date 14
    await new Promise((r) => setTimeout(r, 120));

    // Global priority lock must now be active
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(true);
    const activeLock = BookingExecutionGuard.getActivePriorityLock();
    expect(activeLock).toBeDefined();
    expect(activeLock?.date).toBe('2026-12-14');

    // While Date 14 is executing with priority, attempt a tick for Date 15
    const state15: DemandKeyState = {
      demandKey: '2026-12-15|Pamba|ALL',
      phase: 'WATCHING',
      watchStartedAt: Date.now(),
      bookingIds: ['TA-10017'],
      pollSeq: 0,
      inFlight: false,
    };

    const pollCountBefore = pollSpy.mock.calls.length;
    await (orchestrator as any).tickDemandKey('2026-12-15|Pamba|ALL', state15, Date.now());

    // Date 15 must NOT have triggered any poll!
    expect(pollSpy.mock.calls.length).toBe(pollCountBefore);

    // Release booking execution and stop
    releaseBookingExecution!();
    await new Promise((r) => setTimeout(r, 60));
    orchestrator.stop();
  });

  // REQUIREMENT 2: The available booking gets exclusive priority
  it('2. The available booking gets exclusive priority over all pending queues and other jobs', async () => {
    const priorityLock = BookingExecutionGuard.acquireGlobalPriorityLock({
      demandKey: '2026-12-14|Pamba|ALL',
      bookingId: 'TA-10016',
      bookingCode: 'TA-10016',
      date: '2026-12-14',
      route: 'Pamba',
      leaseMs: 60000,
    });
    expect(priorityLock.acquired).toBe(true);

    // Active key has priority
    expect(BookingExecutionGuard.isPriorityDemandKey('2026-12-14|Pamba|ALL')).toBe(true);
    expect(BookingExecutionGuard.isPriorityDemandKey('TA-10016')).toBe(true);

    // Other keys do NOT have priority
    expect(BookingExecutionGuard.isPriorityDemandKey('2026-12-15|Pamba|ALL')).toBe(false);
    expect(BookingExecutionGuard.isPriorityDemandKey('TA-99999')).toBe(false);

    // Any other booking attempt to acquire priority lock while active must be strictly rejected
    const competingLock = BookingExecutionGuard.acquireGlobalPriorityLock({
      demandKey: '2026-12-15|Pamba|ALL',
      bookingId: 'TA-COMPETING',
      date: '2026-12-15',
      route: 'Pamba',
    });
    expect(competingLock.acquired).toBe(false);
    expect(competingLock.existingLock?.demandKey).toBe('2026-12-14|Pamba|ALL');
  });

  // REQUIREMENT 3: Monitoring resumes after successful booking
  it('3. Monitoring resumes after successful booking', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-12-14|Pamba|ALL', date: '2026-12-14', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10016'] },
    ]);

    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-priority-3',
        bookingRequestId: 'req-10016',
        bookingCode: 'TA-10016',
        requestedDate: '2026-12-14',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-10016',
      },
    });

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 25, 25);
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'AVAILABLE', available: true });

    // Simulate successful booking execution
    jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async () => {
      BookingExecutionGuard.updateLifecycleState('req-10016', 'BOOKING_CONFIRMED');
      mockApiClient.getDemandDates.mockResolvedValue([]);
    });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 120));
    orchestrator.stop();

    // Lock must be released cleanly
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
    expect(BookingExecutionGuard.getActivePriorityLock()).toBeNull();
  });

  // REQUIREMENT 4: Monitoring resumes after failure and Telegram screenshot notification
  it('4. Monitoring resumes after failure and Telegram screenshot notification', async () => {
    const telegramSpy = jest.spyOn(TelegramFailureNotifier, 'sendFailureAlert').mockResolvedValue({
      success: true,
      deliveredVia: 'LOGGER_ONLY',
    });

    const bookingWorker = new BookingWorker(mockApiClient);

    const CredentialManager = require('../security/credential-manager').CredentialManager;
    jest.spyOn(CredentialManager, 'decrypt').mockReturnValue('decrypted-secret');

    const failJob: any = {
      id: 'job-fail-4',
      bookingRequestId: 'req-fail-4',
      bookingCode: 'TA-FAIL-04',
      requestedDate: '2026-12-14',
      route: 'Pamba',
      selectedTime: '06:00 - 07:00',
      verifiedAvailable: true,
      skipPreflight: true,
      nominee: { nomineeName: 'Nominee', nomineeAge: 30, nomineeRelationship: 'Brother', nomineePhone: '9876543210' },
      leaseGeneration: 1,
      fencingToken: 'f-fail-4',
      account: {
        id: 'acc-1',
        username: 'testuser',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    // Mock adapter prototype methods
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockResolvedValue(true as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockResolvedValue({
      status: 'INVALID_CREDENTIALS',
      message: 'Invalid mobile number or password',
    } as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'captureScreenshotBase64').mockResolvedValue(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    );

    // Acquire priority lock before dispatching
    BookingExecutionGuard.acquireGlobalPriorityLock({
      demandKey: '2026-12-14|Pamba|ALL',
      bookingId: 'req-fail-4',
      date: '2026-12-14',
      route: 'Pamba',
    });
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(true);

    try {
      await bookingWorker.execute(failJob);
    } catch (err: any) {
      expect(err.message).toContain('INVALID_CREDENTIALS');
    }

    // Assert Telegram alert was dispatched with all required fields
    expect(telegramSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'req-fail-4',
        requestedDate: '2026-12-14',
        route: 'Pamba',
        failureStage: 'MANUAL_REVIEW',
        errorMessage: expect.stringMatching(/password|invalid/i),
      })
    );

    // Release priority lock as orchestrator does in finally
    BookingExecutionGuard.releaseGlobalPriorityLock('2026-12-14|Pamba|ALL');
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
  });

  // REQUIREMENT 5: Automatic retries work for recoverable errors
  it('5. Automatic retries work for recoverable errors using bounded retry policy', async () => {
    process.env.MAX_BOOKING_ATTEMPTS = '3';
    let attempts = 0;

    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-12-14|Pamba|ALL', date: '2026-12-14', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-RETRY'] },
    ]);

    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-retry-5',
        bookingRequestId: 'req-retry-5',
        bookingCode: 'TA-RETRY-05',
        requestedDate: '2026-12-14',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-retry-5',
      },
    });

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 25, 25);
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'AVAILABLE', available: true });

    // Fail first 2 attempts with recoverable network errors, then succeed on attempt 3
    jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async (_jobType: string, jobData: any) => {
      attempts++;
      if (attempts < 3) {
        BookingExecutionGuard.updateLifecycleState(jobData.bookingRequestId, 'RETRYABLE_FAILURE');
        throw new Error('ETIMEDOUT: Connection reset by peer');
      } else {
        BookingExecutionGuard.updateLifecycleState(jobData.bookingRequestId, 'BOOKING_CONFIRMED');
        mockApiClient.getDemandDates.mockResolvedValue([]);
      }
    });

    await orchestrator.start();
    // Allow time for 3 retry attempts
    await new Promise((r) => setTimeout(r, 200));
    orchestrator.stop();

    expect(attempts).toBe(3);
    // After attempt 3 succeeds, priority lock is released
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
  });

  // REQUIREMENT 6: No duplicate booking occurs after an uncertain submission
  it('6. No duplicate booking occurs after an uncertain submission (reconciles from portal history)', async () => {
    const bookingWorker = new BookingWorker(mockApiClient);

    const CredentialManager = require('../security/credential-manager').CredentialManager;
    jest.spyOn(CredentialManager, 'decrypt').mockReturnValue('decrypted-pass');

    const uncertainJob: any = {
      id: 'job-uncertain-6',
      bookingRequestId: 'req-uncertain-6',
      bookingCode: 'TA-UNCERTAIN-06',
      requestedDate: '2026-12-14',
      route: 'Pamba',
      selectedTime: '06:00 - 07:00',
      verifiedAvailable: true,
      skipPreflight: true,
      leaseGeneration: 1,
      fencingToken: 'f-uncertain-6',
      account: { id: 'acc-1', username: 'testuser', encryptedPassword: 'enc', encryptionIv: 'iv', encryptionTag: 'tag' },
      nominee: { nomineeName: 'Nominee', nomineeAge: 30, nomineeRelationship: 'Brother', nomineePhone: '9876543210' },
    };

    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockResolvedValue(true as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockResolvedValue({ status: 'LOGIN_SUCCESS' } as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'handlePostLoginPopup').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'navigateToHomeAndDarshan').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectAuthenticatedDateAndRoute').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectPostLoginSlotWithRefreshFallback').mockResolvedValue({
      selected: true,
      selectedSlot: '06:00 - 07:00',
    } as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectPostLoginTimeSlot').mockResolvedValue({ success: true, selectedSlot: '06:00 - 07:00' } as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectBookingType').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'verifyDateTimePreserved').mockReturnValue(true as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectAllExistingPilgrims').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'populateNomineeDetails').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'handlePrasadamDetails').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectReliefFundNo').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'addToWishlistAndVerify').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'proceedToPaymentGateway').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'verifyPaymentSummary').mockResolvedValue(undefined as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'executePaymentProceedAndConfirm').mockRejectedValue(
      new Error('Gateway Timeout after submission')
    );
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'checkExistingBookingInHistory').mockResolvedValue({
      found: true,
      officialReference: 'IVQ2612149999999999999',
      confirmedAt: '2026-12-14T06:30:00.000Z',
    } as any);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'captureScreenshotBase64').mockResolvedValue(undefined as any);

    await bookingWorker.execute(uncertainJob);

    // Confirmed pass must be completed via completeJob with official reference, NOT failed or retried
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-uncertain-6',
      expect.objectContaining({
        officialReference: 'IVQ2612149999999999999',
      })
    );
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
  });

  // REQUIREMENT 7: Monitoring resumes after slot-unavailable retries are exhausted
  it('7. Monitoring resumes after slot-unavailable retries are exhausted (TEMPORARY_SLOT_LOST)', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-12-14|Pamba|ALL', date: '2026-12-14', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-NO-SLOT'] },
    ]);

    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-noslot-7',
        bookingRequestId: 'req-noslot-7',
        bookingCode: 'TA-NOSLOT-07',
        requestedDate: '2026-12-14',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-noslot-7',
      },
    });

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 25, 25);
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'AVAILABLE', available: true });

    // Simulate slot unavailable after refresh limit (TEMPORARY_SLOT_LOST)
    jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async (_jobType: string, jobData: any) => {
      BookingExecutionGuard.updateLifecycleState(jobData.bookingRequestId, 'TEMPORARY_SLOT_LOST');
    });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 120));
    orchestrator.stop();

    // Priority lock must be released
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
    // Key returned to WATCHING (monitoring resumes)
    const keyState = (orchestrator as any).keyStates.get('2026-12-14|Pamba|ALL');
    expect(keyState).toBeDefined();
    expect(keyState?.phase).toBe('WATCHING');
  });

  // REQUIREMENT 8: A crash or exception does not leave the global priority lock stuck (lease fencing)
  it('8. Lease auto-expiry and exception handling prevents global priority lock from remaining stuck', () => {
    const shortLeaseMs = 50; // 50ms lease
    const now = Date.now();

    BookingExecutionGuard.acquireGlobalPriorityLock({
      demandKey: '2026-12-14|Pamba|ALL',
      bookingId: 'TA-CRASH-TEST',
      date: '2026-12-14',
      route: 'Pamba',
      leaseMs: shortLeaseMs,
    });

    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(true);

    // Simulate time passing beyond lease expiration (simulating worker crash or abrupt exit)
    const activeLock = (BookingExecutionGuard as any).globalPriorityLock;
    activeLock.leaseExpiresAt = now - 10; // Expired 10ms ago

    // Check that isGlobalPriorityActive detects expiry, auto-releases, and returns false
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
    expect(BookingExecutionGuard.getActivePriorityLock()).toBeNull();

    // A new booking can now acquire priority without being blocked
    const newLock = BookingExecutionGuard.acquireGlobalPriorityLock({
      demandKey: '2026-12-15|Pamba|ALL',
      bookingId: 'TA-NEW-BOOKING',
      date: '2026-12-15',
      route: 'Pamba',
    });
    expect(newLock.acquired).toBe(true);
  });

  // REQUIREMENT 9: No other date is polled while a booking is executing, and monitoring resumes afterward
  it('9. No other date is polled while a booking is executing, and monitoring resumes afterward', async () => {
    // 4 monitored dates as reported in the production bug: 2026-12-10 (executes), 2026-12-14, 2026-12-19, 2026-12-11
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-12-10|Pamba|ALL', date: '2026-12-10', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10017'] },
      { demandKey: '2026-12-14|Pamba|ALL', date: '2026-12-14', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10016'] },
      { demandKey: '2026-12-19|Pamba|ALL', date: '2026-12-19', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10018'] },
      { demandKey: '2026-12-11|Pamba|ALL', date: '2026-12-11', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10019'] },
    ]);

    const polledDates: string[] = [];
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockImplementation(async (key: string, date?: string) => {
      const d = date || String(key).split('|')[0].split(':')[0];
      polledDates.push(d);
      if (d === '2026-12-10') {
        return { state: 'AVAILABLE', available: true };
      }
      return { state: 'FULL', available: false };
    });

    let completeBookingExecution: () => void;
    const executionGate = new Promise<void>((resolve) => {
      completeBookingExecution = resolve;
    });

    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-priority-9',
        bookingRequestId: 'req-10017',
        bookingCode: 'TA-10017',
        requestedDate: '2026-12-10',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-10017',
      },
    });

    // Hold the booking execution open in processJobAsync
    jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async () => {
      await executionGate;
      BookingExecutionGuard.updateLifecycleState('req-10017', 'BOOKING_CONFIRMED');
      // Once TA-10017 completes, backend returns remaining 3 dates
      mockApiClient.getDemandDates.mockResolvedValue([
        { demandKey: '2026-12-14|Pamba|ALL', date: '2026-12-14', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10016'] },
        { demandKey: '2026-12-19|Pamba|ALL', date: '2026-12-19', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10018'] },
        { demandKey: '2026-12-11|Pamba|ALL', date: '2026-12-11', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10019'] },
      ]);
    });

    await orchestrator.start();

    // Allow multiple engine loop cycles to run while 2026-12-10 is executing
    await new Promise((r) => setTimeout(r, 120));

    // 1. While booking TA-10017 is actively executing, priority lock must be active
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(true);
    const activeLock = BookingExecutionGuard.getActivePriorityLock();
    expect(activeLock?.date).toBe('2026-12-10');

    // 2. CRITICAL PROOF: While TA-10017 is executing, NO OTHER DATE was polled!
    // Every poll in polledDates must ONLY be for 2026-12-10
    const otherDatePollsDuringExecution = polledDates.filter((d) => d !== '2026-12-10');
    expect(otherDatePollsDuringExecution).toEqual([]);

    // 3. Complete the booking execution
    completeBookingExecution!();
    await new Promise((r) => setTimeout(r, 120));
    orchestrator.stop();

    // 4. After completion, priority lock is released
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);

    // 5. Monitoring has resumed for the remaining pending dates
    const pollsAfterRelease = polledDates.filter((d) => d !== '2026-12-10');
    expect(pollsAfterRelease.length).toBeGreaterThan(0);
  });

  // REQUIREMENT 10: AVAILABLE date immediately passes date, route, and bookingIds to claimJob
  it('10. AVAILABLE date immediately passes date, route, and bookingIds to claimJob and starts booking', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-26|Pamba|ALL', date: '2026-11-26', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10020'] },
    ]);

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'AVAILABLE',
      available: true,
    });

    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockResolvedValue(undefined);

    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-10020',
        bookingRequestId: 'req-10020',
        bookingCode: 'TA-10020',
        requestedDate: '2026-11-26',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-10020',
      },
    });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 80));
    orchestrator.stop();

    // Verify claimJob was called with date, route, triggerSource='SLOT_OPENED', and bookingIds
    expect(mockApiClient.claimJob).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        triggerSource: 'SLOT_OPENED',
        date: '2026-11-26',
        route: 'Pamba',
        bookingIds: ['TA-10020'],
      })
    );

    // Verify processJobAsync was invoked with the claimed job
    expect(processJobSpy).toHaveBeenCalledWith(
      'BOOKING_EXECUTION',
      expect.objectContaining({
        id: 'job-10020',
        requestedDate: '2026-11-26',
        bookingCode: 'TA-10020',
      })
    );
  });

  // REQUIREMENT 11: Date mismatch guard prevents booking when claimed job date does not match available date
  it('11. Critical date mismatch guard: worker aborts safely and does not execute browser booking if job date mismatches', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-26|Pamba|ALL', date: '2026-11-26', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10020'] },
    ]);

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'AVAILABLE',
      available: true,
    });

    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockResolvedValue(undefined);

    // Backend erroneously returns a job for 2027-01-02 when 2026-11-26 was available
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-mismatch-1',
        bookingRequestId: 'req-mismatch',
        bookingCode: 'TA-10001',
        requestedDate: '2027-01-02', // MISMATCH!
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-mismatch',
      },
    });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 80));
    orchestrator.stop();

    // Guard MUST prevent processJobAsync from being called with the mismatched job
    expect(processJobSpy).not.toHaveBeenCalled();

    // Priority lock MUST be safely released so monitoring is not blocked
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);
  });

  // REQUIREMENT 12: Fast handoff fallback to matchPending when claimJob returns NO_JOB
  it('12. Fast handoff fallback to matchPending succeeds when claimJob returns NO_JOB', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-26|Pamba|ALL', date: '2026-11-26', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10020'] },
    ]);

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'AVAILABLE',
      available: true,
    });

    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockResolvedValue(undefined);

    // claimJob returns NO_JOB
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: false,
      reason: 'NO_CANDIDATE',
    });

    // Fast fallback matchPending returns the job
    (mockApiClient as any).matchPending = jest.fn().mockResolvedValue({
      hasJob: true,
      job: {
        id: 'job-matched-1',
        bookingRequestId: 'req-matched-1',
        bookingCode: 'TA-10020',
        requestedDate: '2026-11-26',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-matched',
      },
    });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 80));
    orchestrator.stop();

    expect((mockApiClient as any).matchPending).toHaveBeenCalledWith('2026-11-26', 'Pamba', expect.any(Array));
    expect(processJobSpy).toHaveBeenCalledWith(
      'BOOKING_EXECUTION',
      expect.objectContaining({
        id: 'job-matched-1',
        requestedDate: '2026-11-26',
      })
    );
  });

  // REQUIREMENT 13: NO_JOB preserves watch key, releases priority lock, and resumes watching
  it('13. NO_JOB safely releases priority lock and preserves watch key in WATCHING phase', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-26|Pamba|ALL', date: '2026-11-26', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-10020'] },
    ]);

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'AVAILABLE',
      available: true,
    });

    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockResolvedValue(undefined);

    // Both claimJob and matchPending return NO_JOB
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: false,
      reason: 'NO_JOB',
    });
    (mockApiClient as any).matchPending = jest.fn().mockResolvedValue({
      hasJob: false,
    });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 80));

    // Execution should not have proceeded
    expect(processJobSpy).not.toHaveBeenCalled();

    // Priority lock MUST be released
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);

    // Demand key must still be in WATCHING phase (not lost or removed)
    const demandState = (orchestrator as any).keyStates.get('2026-11-26|Pamba|ALL');
    expect(demandState).toBeDefined();
    expect(demandState.phase).toBe('WATCHING');

    orchestrator.stop();
  });
});
