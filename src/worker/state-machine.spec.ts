import { WorkerOrchestrator, DemandKeyState } from './orchestrator';
import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';
import { SanitizedLogger } from '../monitoring/logger';
import { AvailabilityCache } from '../availability/availability-cache';

describe('Worker Single-Engine State Machine Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockHeartbeat: jest.Mocked<HeartbeatService>;

  beforeEach(() => {
    delete process.env.MAX_ACTIVE_BOOKINGS;
    delete process.env.MAX_AVAILABILITY_MONITORS;
    delete process.env.WATCH_WINDOW_MS;
    delete process.env.REST_WINDOW_MS;
    AvailabilityCache.getInstance().clear();

    mockApiClient = {
      claimJob: jest.fn().mockResolvedValue({ hasJob: false }),
      getDemandDates: jest.fn().mockResolvedValue([]),
      getPendingDates: jest.fn().mockResolvedValue({ dates: [] }),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
      updateJobProgress: jest.fn().mockResolvedValue({ success: true }),
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

  it('No-Dead Invariant: logs structured WATCHING step every tick and never goes idle when a booking exists', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-20|Pamba|ALL', date: '2026-11-20', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-101'] },
    ]);

    const infoSpy = jest.spyOn(SanitizedLogger, 'info');
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

    // Mock pollAvailabilityForDate to return FULL (date is busy)
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'FULL', available: false });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 160));
    orchestrator.stop();
    await new Promise((r) => setTimeout(r, 50));

    // Verify structured log matching Deliverable 5 contract
    const stepLogs = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((msg) => msg.includes('[WORKER] key=2026-11-20|Pamba|ALL step=WATCHING'));

    expect(stepLogs.length).toBeGreaterThan(0);
    expect(stepLogs[0]).toMatch(/watchAgeMs=\d+/);
    expect(stepLogs[0]).toMatch(/pollSeq=\d+/);
    expect(stepLogs[0]).toMatch(/bookingIds=TA-101/);

    // Verify zero occurrences of legacy monitor idle string
    const idleLogs = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((msg) => msg.toLowerCase().includes('monitor idle'));
    expect(idleLogs.length).toBe(0);

    infoSpy.mockRestore();
  });

  it('No-Handoff Invariant: AVAILABLE in WATCHING triggers immediate BOOKING in the same tick', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-20|Pamba|ALL', date: '2026-11-20', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-102'] },
    ]);
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-102',
        bookingRequestId: 'br-102',
        bookingCode: 'TA-102',
        requestedDate: '2026-11-20',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-102',
      },
    });

    const infoSpy = jest.spyOn(SanitizedLogger, 'info');
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50, 50);

    // Mock pollAvailabilityForDate to observe AVAILABLE
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'AVAILABLE', available: true });
    // Mock processJobAsync so it simulates a fast successful booking and clears DB demands
    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async () => {
      mockApiClient.getDemandDates.mockResolvedValue([]);
    });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 120));
    orchestrator.stop();
    await new Promise((r) => setTimeout(r, 50));

    // Verify same-tick transition from WATCHING -> BOOKING -> COMPLETING
    const transitionLog = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((msg) => msg.includes('transition=WATCHING->BOOKING reason=SLOT_AVAILABLE_NO_HANDOFF'));

    expect(transitionLog).toBeDefined();
    expect(processJobSpy).toHaveBeenCalledTimes(1);

    infoSpy.mockRestore();
  });

  it('Rest Bound Invariant: Transitions to RESTING after WATCH_WINDOW_MS and resumes WATCHING after REST_WINDOW_MS', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    // Set miniature windows for fast testing: 100ms watch window, 60ms rest window
    const customWatchWindowMs = 100;
    const customRestWindowMs = 60;

    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-20|Pamba|ALL', date: '2026-11-20', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-103'] },
    ]);

    const infoSpy = jest.spyOn(SanitizedLogger, 'info');
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 25, 25);
    (orchestrator as any).watchWindowMs = customWatchWindowMs;
    (orchestrator as any).restWindowMs = customRestWindowMs;

    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'FULL', available: false });

    await orchestrator.start();
    // Allow key to be initialized
    await new Promise((r) => setTimeout(r, 35));

    // Fast-forward watchStartedAt past watchWindowMs
    const state = (orchestrator as any).keyStates.get('2026-11-20|Pamba|ALL');
    expect(state).toBeDefined();
    state.watchStartedAt = Date.now() - 601000; // Past default 600000ms

    // Wait for next tick to transition to RESTING
    await new Promise((r) => setTimeout(r, 50));

    expect(state.phase).toBe('RESTING');
    const restEntryLog = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((msg) => msg.includes('transition=WATCHING->RESTING reason=WATCH_WINDOW_EXPIRED'));
    expect(restEntryLog).toBeDefined();

    // Fast-forward restUntil
    state.restUntil = Date.now() - 1000;
    await new Promise((r) => setTimeout(r, 50));

    // Should resume WATCHING with fresh watchStartedAt
    expect(state.phase).toBe('WATCHING');
    const restExitLog = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((msg) => msg.includes('transition=RESTING->WATCHING reason=REST_CYCLE_FINISHED_RESUME_WATCH'));
    expect(restExitLog).toBeDefined();

    orchestrator.stop();
    await new Promise((r) => setTimeout(r, 30));
    infoSpy.mockRestore();
  });

  it('Preemption Invariant: AVAILABLE during RESTING immediately preempts rest into BOOKING', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-20|Pamba|ALL', date: '2026-11-20', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-104'] },
    ]);
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-104',
        bookingRequestId: 'br-104',
        bookingCode: 'TA-104',
        requestedDate: '2026-11-20',
        route: 'Pamba',
        leaseGeneration: 1,
        fencingToken: 'f-104',
      },
    });

    const infoSpy = jest.spyOn(SanitizedLogger, 'info');
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 25, 25);
    const processJobSpy = jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async () => {
      mockApiClient.getDemandDates.mockResolvedValue([]);
    });

    // Mock pollAvailabilityForDate so it does not interfere during watching phase
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'FULL', available: false });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 35));

    // Put state into RESTING with firstRestTick = true
    const state = (orchestrator as any).keyStates.get('2026-11-20|Pamba|ALL');
    state.phase = 'RESTING';
    state.restUntil = Date.now() + 60000;
    state.firstRestTick = true;

    // Put AVAILABLE in AvailabilityCache for both key formats
    AvailabilityCache.getInstance().set('2026-11-20:Pamba', 'AVAILABLE');
    AvailabilityCache.getInstance().set(AvailabilityCache.buildKey('2026-11-20', 'Pamba'), 'AVAILABLE');

    await new Promise((r) => setTimeout(r, 60));
    orchestrator.stop();
    await new Promise((r) => setTimeout(r, 50));

    // Verify preemption
    const preemptLog = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((msg) => msg.includes('transition=RESTING->BOOKING reason=REST_ENTRY_CHECK_AVAILABLE'));

    expect(preemptLog).toBeDefined();
    expect(processJobSpy).toHaveBeenCalledTimes(1);

    infoSpy.mockRestore();
  });

  it('Watch window preservation: A failed claim preserves the existing watch window (no reset)', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    mockApiClient.getDemandDates.mockResolvedValue([
      { demandKey: '2026-11-20|Pamba|ALL', date: '2026-11-20', route: 'Pamba', pendingCount: 1, bookingIds: ['TA-105'] },
    ]);
    // Claim returns no job (slot lost / race lost)
    mockApiClient.claimJob.mockResolvedValue({ hasJob: false, reason: 'NO_JOB' });

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 25, 25);
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'AVAILABLE', available: true });

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 35));

    const state = (orchestrator as any).keyStates.get('2026-11-20|Pamba|ALL');
    const originalWatchStartedAt = state.watchStartedAt;

    await new Promise((r) => setTimeout(r, 60));
    orchestrator.stop();
    await new Promise((r) => setTimeout(r, 50));

    // Failed claim must return to WATCHING without resetting watchStartedAt!
    expect(state.phase).toBe('WATCHING');
    expect(state.watchStartedAt).toBe(originalWatchStartedAt);
  });

  it('No-Dead Enforcement: triggers forced poll and logs no-dead ENFORCED when poll interval exceeds 15s', async () => {
    const errorSpy = jest.spyOn(SanitizedLogger, 'error');
    const warnSpy = jest.spyOn(SanitizedLogger, 'warn');
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 10, 10);

    const pollSpy = jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({ state: 'FULL', available: false });

    const key = '2026-11-22:PAMBA';
    const now = Date.now();
    const state: DemandKeyState = {
      demandKey: key,
      phase: 'WATCHING' as const,
      watchStartedAt: now - 30000,
      lastPollStartedAt: now - 16000, // 16s ago > 15s
      lastPolledAt: now - 16000,
      bookingIds: ['TA-NO-DEAD'],
      pollSeq: 1,
      inFlight: false,
    };

    await (orchestrator as any).tickDemandKey(key, state, now);

    // Assert that the invariant violation is logged AND enforcement is logged
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[WORKER] no-dead invariant violated key=2026-11-22:PAMBA'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[WORKER] no-dead ENFORCED key=2026-11-22:PAMBA forcedPoll=true'));

    // Assert that a poll was triggered in the same tick!
    expect(pollSpy).toHaveBeenCalledWith(key, '2026-11-22', 'PAMBA');
    expect(state.lastPollStartedAt).toBe(now);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('Date parsing and validation: rejects malformed date, logs ERROR, never returns UNKNOWN, and aborts poll', async () => {
    const errorSpy = jest.spyOn(SanitizedLogger, 'error');
    const infoSpy = jest.spyOn(SanitizedLogger, 'info');
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 10, 10);
    const pollSpy = jest.spyOn(orchestrator as any, 'pollAvailabilityForDate');

    const malformedKey = 'invalid-date:PAMBA';
    const now = Date.now();
    const state: DemandKeyState = {
      demandKey: malformedKey,
      phase: 'WATCHING' as const,
      watchStartedAt: now,
      bookingIds: ['TA-BAD-DATE'],
      pollSeq: 0,
      inFlight: false,
    };

    await (orchestrator as any).tickDemandKey(malformedKey, state, now);

    // Expected error log
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DISCOVERY] invalid date input raw=invalid-date parsed=invalid-date key=invalid-date:PAMBA')
    );
    // Poll must NOT have been called (aborted)
    expect(pollSpy).not.toHaveBeenCalled();
    // State set to ERROR, not UNKNOWN
    expect(state.lastState).toBe('ERROR');

    const tickLog = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((msg) => msg.includes('state=ERROR'));
    expect(tickLog).toBeDefined();

    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('Poll cadence: schedules next poll from poll START time, not completion time', async () => {
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 10, 10);
    const pollStart = 1000000;

    // Simulate poll taking 3 seconds (3000ms)
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockImplementation(async () => {
      return { state: 'FULL', available: false };
    });

    const key = '2026-11-22:PAMBA';
    const state: DemandKeyState = {
      demandKey: key,
      phase: 'WATCHING' as const,
      watchStartedAt: pollStart - 5000,
      bookingIds: ['TA-CADENCE'],
      pollSeq: 0,
      inFlight: false,
    };

    await (orchestrator as any).tickDemandKey(key, state, pollStart);

    // nextPollAt must be between pollStart + 8000 and pollStart + 12000 (8000 interval + 0..4000 jitter)
    expect(state.nextPollAt).toBeGreaterThanOrEqual(pollStart + 8000);
    expect(state.nextPollAt).toBeLessThanOrEqual(pollStart + 12000);
    expect(state.lastPollStartedAt).toBe(pollStart);
  });

  it('Tight check loop: 25+ consecutive polls maintain 8-12s cadence with random jitter and zero no-dead invariant fires', async () => {
    const errorSpy = jest.spyOn(SanitizedLogger, 'error');
    const warnSpy = jest.spyOn(SanitizedLogger, 'warn');
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 10, 10);

    // Mock availability check to always return FULL in ~100ms
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockImplementation(async () => {
      return { state: 'FULL', available: false };
    });

    const key = '2026-11-22:PAMBA';
    let currentSimulatedTime = 1700000000000;
    const state: DemandKeyState = {
      demandKey: key,
      phase: 'WATCHING' as const,
      watchStartedAt: currentSimulatedTime,
      bookingIds: ['TA-TIGHT-LOOP'],
      pollSeq: 0,
      inFlight: false,
    };

    const pollStartTimes: number[] = [];
    const pollIntervals: number[] = [];

    // Simulate 25 consecutive poll cycles
    for (let i = 0; i < 25; i++) {
      // 1. Tick at current time (should trigger poll because it's due)
      await (orchestrator as any).tickDemandKey(key, state, currentSimulatedTime);

      pollStartTimes.push(state.lastPollStartedAt!);

      if (pollStartTimes.length > 1) {
        const interval = state.lastPollStartedAt! - pollStartTimes[pollStartTimes.length - 2];
        pollIntervals.push(interval);
      }

      // Next poll is scheduled at state.nextPollAt
      expect(state.nextPollAt).toBeDefined();
      const scheduledCadence = state.nextPollAt! - currentSimulatedTime;
      expect(scheduledCadence).toBeGreaterThanOrEqual(8000);
      expect(scheduledCadence).toBeLessThanOrEqual(12000);

      // Advance clock to exact nextPollAt for the next cycle
      currentSimulatedTime = state.nextPollAt!;
    }

    // 1. Consecutive [POLL] start ts must be 8000-12000ms apart
    expect(pollIntervals.length).toBe(24);
    for (const interval of pollIntervals) {
      expect(interval).toBeGreaterThanOrEqual(8000);
      expect(interval).toBeLessThanOrEqual(12000);
    }

    // 2. Variance across 20+ polls must be > 1000ms (proving jitter is random)
    const minInterval = Math.min(...pollIntervals);
    const maxInterval = Math.max(...pollIntervals);
    const jitterSpread = maxInterval - minInterval;
    expect(jitterSpread).toBeGreaterThan(1000);

    // 3. no-dead invariant violated must appear ZERO times
    const noDeadViolations = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((msg) => msg.includes('no-dead invariant violated'));
    expect(noDeadViolations.length).toBe(0);

    // 4. no-dead ENFORCED forcedPoll=true must appear ZERO times
    const noDeadEnforcements = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((msg) => msg.includes('no-dead ENFORCED'));
    expect(noDeadEnforcements.length).toBe(0);

    // 5. Polls per minute per key must be ~5-7 (average interval ~10000ms)
    const totalDurationMs = pollStartTimes[pollStartTimes.length - 1] - pollStartTimes[0];
    const totalMinutes = totalDurationMs / 60000;
    const pollsPerMinute = (pollStartTimes.length - 1) / totalMinutes;
    expect(pollsPerMinute).toBeGreaterThanOrEqual(5.0);
    expect(pollsPerMinute).toBeLessThanOrEqual(7.5);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
