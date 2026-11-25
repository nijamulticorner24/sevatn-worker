import { WorkerOrchestrator } from '../worker/orchestrator';
import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';
import { BookingExecutionGuard } from '../security/execution-guard';
import { AvailabilityCache } from '../availability/availability-cache';
import { BookingWorker } from './booking-worker';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

describe('SevaTN Worker Date Match Audit & Safe Retry Specification Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockHeartbeat: jest.Mocked<HeartbeatService>;

  beforeEach(() => {
    AvailabilityCache.getInstance().clear();
    BookingExecutionGuard.clearAll();

    mockApiClient = {
      claimJob: jest.fn().mockResolvedValue({ hasJob: false }),
      matchPending: jest.fn().mockResolvedValue({ hasJob: false }),
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

  // TEST 1: AVAILABLE date matches request date: execution may proceed
  it('1. AVAILABLE date matches request date: execution may proceed', async () => {
    const targetDate = '2026-11-24';
    const targetRoute = 'Pamba (Regular Footpath Route)';
    const demandKey = `${targetDate}:${targetRoute}`;

    mockApiClient.getDemandDates.mockResolvedValue([
      {
        demandKey,
        date: targetDate,
        route: targetRoute,
        pendingCount: 1,
        bookingIds: ['TA-10001'],
      },
    ]);

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'AVAILABLE',
      available: true,
    });

    // Backend returns matching job for 2026-11-24
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-matching-1',
        bookingRequestId: 'req-10001',
        bookingCode: 'TA-10001',
        requestedDate: '2026-11-24',
        route: targetRoute,
        leaseGeneration: 1,
        fencingToken: 'fence-10001',
      },
    });

    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockResolvedValue(undefined);

    await (orchestrator as any).syncWatchSetFromDb(Date.now());
    const state1 = (orchestrator as any).keyStates.get(demandKey);
    await (orchestrator as any).tickDemandKey(demandKey, state1, Date.now());

    // Verify claim was submitted with exact target date & route
    expect(mockApiClient.claimJob).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        triggerSource: 'SLOT_OPENED',
        date: targetDate,
        route: targetRoute,
      })
    );

    // Execution must proceed to processJobAsync because dates match exactly
    expect(processJobSpy).toHaveBeenCalledTimes(1);
    expect(processJobSpy).toHaveBeenCalledWith(
      'BOOKING_EXECUTION',
      expect.objectContaining({
        id: 'job-matching-1',
        bookingCode: 'TA-10001',
        requestedDate: '2026-11-24',
      })
    );
  });

  // TEST 2: AVAILABLE date differs from request date: execution must be blocked
  it('2. AVAILABLE date differs from request date: execution must be blocked', async () => {
    const detectedAvailableDate = '2026-11-24';
    const mismatchedJobDate = '2027-01-06';
    const targetRoute = 'Pamba (Regular Footpath Route)';
    const demandKey = `${detectedAvailableDate}:${targetRoute}`;

    mockApiClient.getDemandDates.mockResolvedValue([
      {
        demandKey,
        date: detectedAvailableDate,
        route: targetRoute,
        pendingCount: 1,
        bookingIds: ['TA-10006'],
      },
    ]);

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'AVAILABLE',
      available: true,
    });

    // Backend incorrectly returns job TA-10006 for 2027-01-06 when 2026-11-24 was detected
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-mismatch-6',
        bookingRequestId: 'req-10006',
        bookingCode: 'TA-10006',
        requestedDate: mismatchedJobDate, // Mismatched date!
        route: targetRoute,
        leaseGeneration: 1,
        fencingToken: 'fence-10006',
      },
    });

    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockResolvedValue(undefined);

    await (orchestrator as any).syncWatchSetFromDb(Date.now());
    const state1 = (orchestrator as any).keyStates.get(demandKey);
    await (orchestrator as any).tickDemandKey(demandKey, state1, Date.now());

    // Claim was submitted for 2026-11-24
    expect(mockApiClient.claimJob).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        date: detectedAvailableDate,
      })
    );

    // CRITICAL GUARD: processJobAsync must NOT be called for mismatched date!
    expect(processJobSpy).not.toHaveBeenCalled();

    // Priority lock must be released immediately
    expect(BookingExecutionGuard.isGlobalPriorityActive()).toBe(false);

    // State must be reset to WATCHING
    const state = (orchestrator as any).keyStates.get(demandKey);
    expect(state.phase).toBe('WATCHING');
  });

  // TEST 3: Date appears available in discovery but is not selectable: request must not become SUCCESS
  it('3. Date appears available in discovery but is not selectable: request must not become SUCCESS and remains in retryable state', async () => {
    const job = {
      id: 'job-unselectable-1',
      bookingRequestId: 'req-20001',
      bookingCode: 'TA-20001',
      requestedDate: '2026-11-26',
      route: 'Pamba (Regular Footpath Route)',
      fencingToken: 'f-20001',
      leaseGeneration: 1,
      account: {
        username: 'devotee@example.com',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
      pilgrims: [{ fullName: 'Pilgrim One' }],
      nominee: {
        nomineeName: 'Swami Nominee',
        nomineeAge: 35,
        nomineeRelationship: 'BROTHER',
        nomineePhone: '9876543210',
      },
      nomineeName: 'Swami Nominee',
      nomineeAge: 35,
      nomineeRelationship: 'BROTHER',
      nomineePhone: '9876543210',
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true, url: 'https://sabarimalaonline.org/#/darshanAvailability' }),
      // Official calendar reports date disabled or not selectable
      selectRequestedDate: jest.fn().mockResolvedValue({
        success: false,
        error: 'Date cell 2026-11-26 is disabled in portal calendar',
      }),
      selectRoute: jest.fn().mockResolvedValue(undefined),
      clickPortalLoginButton: jest.fn().mockResolvedValue(undefined),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      logout: jest.fn().mockResolvedValue(undefined),
      captureScreenshotBase64: jest.fn().mockResolvedValue('fake-shot'),
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
    (PlaywrightSabarimalaAdapter as unknown as jest.Mock).mockImplementation(() => mockAdapter);

    const bookingWorker = new BookingWorker(mockApiClient);
    await bookingWorker.execute(job as any);

    // 1. Must never call completeJob
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    // 2. Must call failJob with TEMPORARY_SLOT_LOST and DATE_NOT_SELECTABLE
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-unselectable-1',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        errorCode: 'DATE_NOT_SELECTABLE',
      })
    );

    // 3. Execution lock must be released cleanly and request not left in active execution
    expect(BookingExecutionGuard.isBookingActive('req-20001')).toBe(false);
  });

  // TEST 4: Batch response for one date/route cannot trigger another date's request
  it("4. Batch response for one date/route cannot trigger another date's request", async () => {
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

    // Simulate cached batch response for November 2026 on Pamba route
    (orchestrator as any).lastBatchApiResponse = {
      apiOutcome: 'API_VERIFIED',
      route: 'Pamba (Regular Footpath Route)',
      date: '2026-11-24',
      apiAvailabilitySummary: {
        availableDatesList: ['2026-11-24'],
        bookedDatesList: ['2026-11-25'],
        blockedDatesList: [],
        seasonStart: '2026-11-15',
        seasonEnd: '2026-12-26',
      },
    };
    (orchestrator as any).lastBatchApiResponseTs = Date.now();

    // Adapter spy to see if fresh network check is triggered
    const mockAdapter = {
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({
        state: 'FULL',
        available: false,
      }),
    };
    jest.spyOn(orchestrator as any, 'ensureDiscoveryAdapter').mockResolvedValue(mockAdapter);

    // Case A: Query for a different month (January 2027) on Pamba
    // Should NOT reuse November batch response; must trigger fresh check
    const janResult = await (orchestrator as any).pollAvailabilityForDate(
      '2027-01-06:Pamba (Regular Footpath Route)',
      '2027-01-06',
      'Pamba (Regular Footpath Route)'
    );
    expect(mockAdapter.checkRequestedDateAvailability).toHaveBeenCalledWith(
      '2027-01-06',
      expect.objectContaining({ route: 'Pamba (Regular Footpath Route)' })
    );

    // Case B: Query for the same date (2026-11-24) but DIFFERENT route (Erumeli)
    // Should NOT reuse Pamba batch response; must trigger fresh check
    mockAdapter.checkRequestedDateAvailability.mockClear();
    const erumeliResult = await (orchestrator as any).pollAvailabilityForDate(
      '2026-11-24:Erumeli',
      '2026-11-24',
      'Erumeli'
    );
    expect(mockAdapter.checkRequestedDateAvailability).toHaveBeenCalledWith(
      '2026-11-24',
      expect.objectContaining({ route: 'Erumeli' })
    );
  });
});
