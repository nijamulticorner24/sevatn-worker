import { WorkerOrchestrator } from './orchestrator';
import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';
import { SanitizedLogger } from '../monitoring/logger';
import { BookingExecutionGuard } from '../security/execution-guard';

describe('WorkerOrchestrator Cloud & Local Concurrency Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockHeartbeat: jest.Mocked<HeartbeatService>;

  beforeEach(() => {
    BookingExecutionGuard.clearAll();
    delete process.env.MAX_ACTIVE_BOOKINGS;
    delete process.env.MAX_AVAILABILITY_MONITORS;

    mockApiClient = {
      claimJob: jest.fn().mockResolvedValue({ hasJob: false }),
      getDemandDates: jest.fn().mockResolvedValue([]),
    } as any;

    mockHeartbeat = {
      isExecutionPermitted: jest.fn().mockReturnValue(true),
      isDiscoveryPermitted: jest.fn().mockReturnValue(true),
      getDesiredState: jest.fn().mockReturnValue('RUNNING'),
      setExecutionPermitted: jest.fn(),
      setStatus: jest.fn(),
      addActiveJob: jest.fn(),
      removeActiveJob: jest.fn(),
    } as any;
  });

  it('runs in passive monitor-only mode and avoids claim polling when MAX_ACTIVE_BOOKINGS=0', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '0';

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
    await orchestrator.start();

    // Allow multiple loop ticks
    await new Promise((r) => setTimeout(r, 60));
    orchestrator.stop();

    // claimJob should NEVER be called when concurrency is 0
    expect(mockApiClient.claimJob).not.toHaveBeenCalled();
    // Discovery loop still runs
    expect(mockApiClient.getDemandDates).toHaveBeenCalled();
  });

  it('actively polls claimJob when MAX_ACTIVE_BOOKINGS >= 1 and execution is permitted', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
    await orchestrator.start();

    await new Promise((r) => setTimeout(r, 60));
    orchestrator.stop();

    expect(mockApiClient.claimJob).toHaveBeenCalled();
  });

  it('suspends claim polling when Super Admin sets desiredState to STOPPED', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    mockHeartbeat.isExecutionPermitted.mockReturnValue(false);
    mockHeartbeat.isDiscoveryPermitted.mockReturnValue(false);
    mockHeartbeat.getDesiredState.mockReturnValue('STOPPED');

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
    await orchestrator.start();

    await new Promise((r) => setTimeout(r, 60));
    orchestrator.stop();

    expect(mockApiClient.claimJob).not.toHaveBeenCalled();
    expect(mockApiClient.getDemandDates).not.toHaveBeenCalled();
  });

  it('permits discovery while suppressing execution when desiredState is MONITOR_ONLY', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    mockHeartbeat.isExecutionPermitted.mockReturnValue(false);
    mockHeartbeat.isDiscoveryPermitted.mockReturnValue(true);
    mockHeartbeat.getDesiredState.mockReturnValue('MONITOR_ONLY');

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
    await orchestrator.start();

    await new Promise((r) => setTimeout(r, 60));
    orchestrator.stop();

    // Execution should NOT poll
    expect(mockApiClient.claimJob).not.toHaveBeenCalled();
    // Discovery SHOULD run
    expect(mockApiClient.getDemandDates).toHaveBeenCalled();
  });

  describe('slot:opened Event Handling & Debouncing (PR #4 Patch)', () => {
    it('Test 1: A slot:opened event with a matching pending job calls claimJob() exactly once', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: true,
        jobType: 'BOOKING_EXECUTION',
        job: { id: 'job-01', bookingCode: 'TA-01', requestedDate: '2026-11-20', leaseGeneration: 1, fencingToken: 'fence-01' },
      });

      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 20));

      expect(mockApiClient.claimJob).toHaveBeenCalledTimes(1);
    });

    it('Test 2: A slot:opened event with no matching pending job does not call claimJob()', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([]);
      mockApiClient.claimJob.mockResolvedValue({ hasJob: false });

      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 20));

      expect(mockApiClient.claimJob).not.toHaveBeenCalled();
    });

    it('Test 3: A hasJob: false response from claimJob() logs exact reason and does not say Another worker is booking unless CLAIMED_BY_OTHER', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({ hasJob: false, reason: 'NO_JOB' });

      const warnSpy = jest.spyOn(SanitizedLogger, 'warn');
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
      const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync');
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 20));

      expect(mockApiClient.claimJob).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('reason=NO_JOB')
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Another worker is booking')
      );
      expect(processJobSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('Test 3b: Logs Another worker is booking WITH workerId ONLY when CLAIMED_BY_OTHER is returned', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: false,
        reason: 'CLAIMED_BY_OTHER(worker-peer-2)',
        ownerWorkerId: 'worker-peer-2',
      });

      const warnSpy = jest.spyOn(SanitizedLogger, 'warn');
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
      const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync');
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 20));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Another worker is booking.*CLAIMED_BY_OTHER\(worker-peer-2\).*Standing down/i)
      );
      expect(processJobSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('Test 3c: Logs MAX_CAPACITY reason clearly without claiming another worker is booking', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: false,
        reason: 'MAX_CAPACITY(1/1; jobs=job-99[TA-99:RUNNING])',
      });

      const warnSpy = jest.spyOn(SanitizedLogger, 'warn');
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 20));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MAX_CAPACITY(1/1; jobs=job-99[TA-99:RUNNING])')
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Another worker is booking')
      );
      warnSpy.mockRestore();
    });

    it('Test 3d: Duplicate protection — never books if claimed job already has an official reference; retries completeJob and logs ALREADY_COMPLETED', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: true,
        jobType: 'BOOKING_EXECUTION',
        job: {
          id: 'job-done-1',
          bookingRequestId: 'br-done-1',
          bookingCode: 'TA-DONE-01',
          requestedDate: '2026-11-20',
          officialBookingReference: 'IVQ26112019410571880889',
          leaseGeneration: 2,
          fencingToken: 'fence-done-1',
        },
      });
      mockApiClient.completeJob = jest.fn().mockResolvedValue({ success: true });

      const warnSpy = jest.spyOn(SanitizedLogger, 'warn');
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20);
      const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync');
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 30));

      expect(processJobSpy).not.toHaveBeenCalled();
      expect(mockApiClient.completeJob).toHaveBeenCalledWith(
        'job-done-1',
        expect.objectContaining({
          officialBookingReference: 'IVQ26112019410571880889',
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ALREADY_COMPLETED(IVQ26112019410571880889)')
      );
      warnSpy.mockRestore();
    });

    it('Test 4: Two slot:opened events within SLOT_OPEN_DEBOUNCE_MS result in exactly one claimJob() call', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: true,
        jobType: 'BOOKING_EXECUTION',
        job: { id: 'job-01', bookingCode: 'TA-01', requestedDate: '2026-11-20', leaseGeneration: 1, fencingToken: 'fence-01' },
      });

      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20, 5000);
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 20));

      expect(mockApiClient.claimJob).toHaveBeenCalledTimes(1);
    });

    it('Test 5: Two slot:opened events separated by more than SLOT_OPEN_DEBOUNCE_MS result in exactly two claimJob() calls', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: true,
        jobType: 'BOOKING_EXECUTION',
        job: { id: 'job-01', bookingCode: 'TA-01', requestedDate: '2026-11-20', leaseGeneration: 1, fencingToken: 'fence-01' },
      });

      // Pass short debounce interval (40ms) for deterministic test execution
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20, 40);
      (orchestrator as any).processJobAsync = jest.fn().mockResolvedValue(undefined);
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      // First event
      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 10));
      expect(mockApiClient.claimJob).toHaveBeenCalledTimes(1);

      // Wait past debounce threshold (>40ms)
      await new Promise((r) => setTimeout(r, 60));

      // Second event
      discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
      await new Promise((r) => setTimeout(r, 10));
      expect(mockApiClient.claimJob).toHaveBeenCalledTimes(2);
    });

    it('Test 6: A slot:opened event is ignored when a global priority booking is already active', async () => {
      mockApiClient.getDemandDates.mockResolvedValue([
        { date: '2026-11-20', route: 'Pamba', pendingCount: 1 },
      ]);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: true,
        jobType: 'BOOKING_EXECUTION',
        job: { id: 'job-01', bookingCode: 'TA-01', requestedDate: '2026-11-20', leaseGeneration: 1, fencingToken: 'fence-01' },
      });

      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20, 10);
      const discoveryWorker = (orchestrator as any).discoveryWorker;

      BookingExecutionGuard.acquireGlobalPriorityLock({
        demandKey: '2026-11-20:PAMBA',
        date: '2026-11-20',
        route: 'Pamba',
        leaseMs: 60000,
        owner: 'BOOKING_EXECUTION_FLOW',
      });

      try {
        discoveryWorker.emit('slot:opened', { date: '2026-11-20', route: 'Pamba' });
        await new Promise((r) => setTimeout(r, 20));
        expect(mockApiClient.claimJob).not.toHaveBeenCalled();
      } finally {
        BookingExecutionGuard.releaseGlobalPriorityLock();
      }
    });

    it('Test 7: executeBookingFlow prevents concurrent in-flight claims for the same demand key', async () => {
      let claimResolvers: Array<() => void> = [];
      mockApiClient.claimJob.mockImplementation(() => {
        return new Promise((resolve) => {
          claimResolvers.push(() => resolve({
            hasJob: true,
            jobType: 'BOOKING_EXECUTION',
            job: { id: 'job-concurrent-1', bookingCode: 'TA-10001', requestedDate: '2026-12-14', leaseGeneration: 1, fencingToken: 'fence-01' },
          }));
        });
      });

      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 20, 20, 10);
      (orchestrator as any).processJobAsync = jest.fn().mockResolvedValue(undefined);

      const state: any = {
        demandKey: '2026-12-14:PAMBA',
        phase: 'BOOKING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-10001'],
        pollSeq: 1,
        inFlight: true,
      };

      // Launch two concurrent executeBookingFlow calls for the exact same demand key
      const p1 = (orchestrator as any).executeBookingFlow('2026-12-14:PAMBA', state, '2026-12-14', 'Pamba');
      const p2 = (orchestrator as any).executeBookingFlow('2026-12-14:PAMBA', state, '2026-12-14', 'Pamba');

      // Resolve the first in-flight claim
      expect(claimResolvers.length).toBe(1);
      claimResolvers[0]();

      await Promise.all([p1, p2]);

      // Exactly 1 claimJob must be issued, preventing duplicate claiming
      expect(mockApiClient.claimJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('Monitoring Synchronization Resilience Suite (Issue 2 & Task 2)', () => {
    it('preserves existing monitoring set when primary returns 401 and fallback returns 401', async () => {
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

      // Pre-populate keyStates with active demand key
      (orchestrator as any).keyStates.set('2026-11-23:PAMBA', {
        demandKey: '2026-11-23:PAMBA',
        phase: 'WATCHING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-10004'],
        pollSeq: 1,
        inFlight: false,
      });

      // Both endpoints reject with 401 Unauthorized
      const err401: any = new Error('Authentication token required or invalid');
      err401.response = { status: 401, data: { statusCode: 401 } };
      mockApiClient.getDemandDates.mockRejectedValue(err401);
      (mockApiClient as any).getPendingDates = jest.fn().mockRejectedValue(err401);

      await (orchestrator as any).syncWatchSetFromDb(Date.now());

      // Key must be preserved!
      expect((orchestrator as any).keyStates.has('2026-11-23:PAMBA')).toBe(true);
      expect((orchestrator as any).keyStates.size).toBe(1);
    });

    it('preserves existing monitoring set when primary returns 500 error', async () => {
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);
      (orchestrator as any).keyStates.set('2026-11-23:PAMBA', {
        demandKey: '2026-11-23:PAMBA',
        phase: 'WATCHING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-10004'],
        pollSeq: 1,
        inFlight: false,
      });

      const err500: any = new Error('Internal Server Error');
      err500.response = { status: 500 };
      mockApiClient.getDemandDates.mockRejectedValue(err500);
      (mockApiClient as any).getPendingDates = jest.fn().mockRejectedValue(err500);

      await (orchestrator as any).syncWatchSetFromDb(Date.now());

      expect((orchestrator as any).keyStates.has('2026-11-23:PAMBA')).toBe(true);
    });

    it('preserves existing monitoring set when network times out or drops', async () => {
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);
      (orchestrator as any).keyStates.set('2026-11-23:PAMBA', {
        demandKey: '2026-11-23:PAMBA',
        phase: 'WATCHING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-10004'],
        pollSeq: 1,
        inFlight: false,
      });

      mockApiClient.getDemandDates.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
      (mockApiClient as any).getPendingDates = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 172.31.12.80:4000'));

      await (orchestrator as any).syncWatchSetFromDb(Date.now());

      expect((orchestrator as any).keyStates.has('2026-11-23:PAMBA')).toBe(true);
    });

    it('preserves existing monitoring set when primary returns [] but fallback throws 401', async () => {
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);
      (orchestrator as any).keyStates.set('2026-11-23:PAMBA', {
        demandKey: '2026-11-23:PAMBA',
        phase: 'WATCHING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-10004'],
        pollSeq: 1,
        inFlight: false,
      });

      // Primary returns empty, but fallback fails
      mockApiClient.getDemandDates.mockResolvedValue([]);
      const err401: any = new Error('Authentication token required or invalid');
      err401.response = { status: 401 };
      (mockApiClient as any).getPendingDates = jest.fn().mockRejectedValue(err401);

      await (orchestrator as any).syncWatchSetFromDb(Date.now());

      // Key must be preserved because fallback check failed!
      expect((orchestrator as any).keyStates.has('2026-11-23:PAMBA')).toBe(true);
    });

    it('removes keys cleanly only following authoritative successful responses with 0 demands', async () => {
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);
      (orchestrator as any).keyStates.set('2026-11-23:PAMBA', {
        demandKey: '2026-11-23:PAMBA',
        phase: 'WATCHING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-10004'],
        pollSeq: 1,
        inFlight: false,
      });

      // Both primary and fallback return 200 OK with empty lists
      mockApiClient.getDemandDates.mockResolvedValue([]);
      (mockApiClient as any).getPendingDates = jest.fn().mockResolvedValue({ dates: [] });

      await (orchestrator as any).syncWatchSetFromDb(Date.now());

      // Only authoritative empty responses allow removal
      expect((orchestrator as any).keyStates.has('2026-11-23:PAMBA')).toBe(false);
      expect((orchestrator as any).keyStates.size).toBe(0);
    });
  });

  describe('Availability to Booking Handoff & Batch Cycle Suite', () => {
    it('creates eligible booking candidate, records authorization decision and retains candidate safely when MAX_ACTIVE_BOOKINGS=0', async () => {
      process.env.MAX_ACTIVE_BOOKINGS = '0';
      mockHeartbeat.isExecutionPermitted.mockReturnValue(true);
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

      const state: any = {
        demandKey: '2026-11-25:PAMBA',
        phase: 'BOOKING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-10002'],
        pollSeq: 2,
        inFlight: true,
      };

      await (orchestrator as any).executeBookingFlow('2026-11-25:PAMBA', state, '2026-11-25', 'PAMBA');

      // Authorization must fail-closed because MAX_ACTIVE_BOOKINGS=0
      // State safely returned to WATCHING without calling claimJob or acquiring browser execution lock
      expect(state.phase).toBe('WATCHING');
      expect(mockApiClient.claimJob).not.toHaveBeenCalled();
    });

    it('submits claim, acquires local lock and enters execution when worker is authorized with MAX_ACTIVE_BOOKINGS > 0', async () => {
      process.env.MAX_ACTIVE_BOOKINGS = '1';
      mockHeartbeat.isExecutionPermitted.mockReturnValue(true);
      mockApiClient.claimJob.mockResolvedValue({
        hasJob: true,
        jobType: 'BOOKING_EXECUTION',
        job: {
          id: 'job-test-777',
          bookingRequestId: 'req-777',
          bookingCode: 'TA-777',
          requestedDate: '2026-11-25',
          route: 'PAMBA',
          leaseGeneration: 1,
          fencingToken: 'fence-777',
        },
      });

      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);
      const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(() => Promise.resolve());

      const state: any = {
        demandKey: '2026-11-25:PAMBA',
        phase: 'BOOKING',
        watchStartedAt: Date.now(),
        bookingIds: ['TA-777'],
        pollSeq: 3,
        inFlight: true,
      };

      await (orchestrator as any).executeBookingFlow('2026-11-25:PAMBA', state, '2026-11-25', 'PAMBA');

      expect(mockApiClient.claimJob).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          triggerSource: 'SLOT_OPENED',
          date: '2026-11-25',
          route: 'PAMBA',
          maxActiveBookings: 1,
        })
      );
      expect(processJobSpy).toHaveBeenCalled();
    });

    it('reuses single fresh API response across multiple pending dates in the same batch cycle', async () => {
      const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

      // Set cached batch API response with 2026-11-25 as AVAILABLE and 2026-11-26 as FULL
      (orchestrator as any).lastBatchApiResponse = {
        apiOutcome: 'API_VERIFIED',
        apiResponseTs: Date.now(),
        apiAvailabilitySummary: {
          isAvailableInApi: true,
          isBookedInApi: false,
          isBlockedInApi: false,
          seasonStart: '2026-11-01',
          seasonEnd: '2027-01-20',
          availableDatesList: ['2026-11-25'],
          bookedDatesList: ['2026-11-26'],
          blockedDatesList: [],
        },
      };
      (orchestrator as any).lastBatchApiResponseTs = Date.now();

      // Check first pending date (2026-11-25) -> directly evaluated as AVAILABLE without page reload
      const res1 = await (orchestrator as any).pollAvailabilityForDate('2026-11-25:PAMBA', '2026-11-25', 'PAMBA');
      expect(res1.state).toBe('AVAILABLE');
      expect(res1.available).toBe(true);

      // Check second pending date (2026-11-26) -> directly evaluated as FULL from same batch payload
      const res2 = await (orchestrator as any).pollAvailabilityForDate('2026-11-26:PAMBA', '2026-11-26', 'PAMBA');
      expect(res2.state).toBe('FULL');
      expect(res2.available).toBe(false);
    });
  });
});
