import { WorkerOrchestrator } from './orchestrator';
import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';
import { SanitizedLogger } from '../monitoring/logger';

describe('WorkerOrchestrator Cloud & Local Concurrency Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockHeartbeat: jest.Mocked<HeartbeatService>;

  beforeEach(() => {
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
  });
});
