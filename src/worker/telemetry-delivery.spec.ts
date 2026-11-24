import { WorkerOrchestrator } from './orchestrator';
import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';

describe('Worker Telemetry Delivery & Reliability Suite', () => {
  let mockApiClient: any;
  let mockHeartbeat: any;

  beforeEach(() => {
    mockApiClient = {
      claimJob: jest.fn().mockResolvedValue({ hasJob: false }),
      getDemandDates: jest.fn().mockResolvedValue([]),
      sendPollEvents: jest.fn().mockResolvedValue({ success: true, recorded: 1 }),
      sendWorkerStop: jest.fn().mockResolvedValue({ success: true }),
    };

    mockHeartbeat = {
      isExecutionPermitted: jest.fn().mockReturnValue(true),
      isDiscoveryPermitted: jest.fn().mockReturnValue(true),
      getDesiredState: jest.fn().mockReturnValue('RUNNING'),
      setStatus: jest.fn(),
      sendImmediate: jest.fn().mockResolvedValue(true),
      stop: jest.fn(),
    };
  });

  it('1. Failed telemetry submission & retry: retains event in queue and retries with backoff', async () => {
    // First call rejects with network failure
    mockApiClient.sendPollEvents
      .mockRejectedValueOnce(new Error('Network gateway timeout (504)'))
      .mockResolvedValueOnce({ success: true, recorded: 1 });

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 100, 100);

    orchestrator.recordTelemetry({
      demandKey: '2026-12-05_Pamba',
      date: '2026-12-05',
      route: 'Pamba',
      pollSeq: 1,
      state: 'FULL',
      durationMs: 140,
    });

    expect(orchestrator.getTelemetryQueueLength()).toBe(1);

    // Run first process attempt (fails)
    await orchestrator.processTelemetryQueue();
    expect(mockApiClient.sendPollEvents).toHaveBeenCalledTimes(1);
    expect(orchestrator.getTelemetryQueueLength()).toBe(1);

    const queued = orchestrator.getQueuedTelemetry();
    expect(queued[0].attempts).toBe(1);
    expect(queued[0].nextRetryAt).toBeGreaterThan(Date.now());

    // Reset nextRetryAt to allow immediate retry
    (queued[0] as any).nextRetryAt = 0;

    // Run second process attempt (succeeds)
    await orchestrator.processTelemetryQueue();
    expect(mockApiClient.sendPollEvents).toHaveBeenCalledTimes(2);
    expect(orchestrator.getTelemetryQueueLength()).toBe(0);

    orchestrator.stop();
  });

  it('2. Retry preserving original event identity: preserves workerSessionId, demandKey, and pollSeq', async () => {
    mockApiClient.sendPollEvents
      .mockRejectedValueOnce(new Error('Connection reset'))
      .mockResolvedValueOnce({ success: true, recorded: 1 });

    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 100, 100);
    const originalSessionId = orchestrator.getWorkerSessionId();

    orchestrator.recordTelemetry({
      demandKey: '2026-12-06_Erumeli',
      date: '2026-12-06',
      route: 'Erumeli',
      pollSeq: 42,
      state: 'AVAILABLE',
      durationMs: 85,
    });

    // Attempt 1: fails
    await orchestrator.processTelemetryQueue();
    expect(orchestrator.getTelemetryQueueLength()).toBe(1);

    // Reset retry timer
    const item = orchestrator.getQueuedTelemetry()[0];
    (item as any).nextRetryAt = 0;

    // Attempt 2: succeeds
    await orchestrator.processTelemetryQueue();
    expect(mockApiClient.sendPollEvents).toHaveBeenCalledTimes(2);

    // Both calls must have delivered identical session, demandKey, and pollSeq
    const call1Payload = mockApiClient.sendPollEvents.mock.calls[0][0];
    const call2Payload = mockApiClient.sendPollEvents.mock.calls[1][0];

    expect(call1Payload.workerSessionId).toBe(originalSessionId);
    expect(call2Payload.workerSessionId).toBe(originalSessionId);
    expect(call1Payload.events[0].pollSeq).toBe(42);
    expect(call2Payload.events[0].pollSeq).toBe(42);
    expect(call1Payload.events[0].demandKey).toBe('2026-12-06_Erumeli');
    expect(call2Payload.events[0].demandKey).toBe('2026-12-06_Erumeli');

    orchestrator.stop();
  });

  it('3. Queue capacity limits: caps buffer at MAX_TELEMETRY_QUEUE_SIZE (500) and drops oldest events', () => {
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 100, 100);
    const maxSize = orchestrator.MAX_TELEMETRY_QUEUE_SIZE;

    // Push maxSize + 15 events
    for (let i = 1; i <= maxSize + 15; i++) {
      orchestrator.recordTelemetry({
        demandKey: '2026-12-05_Pamba',
        date: '2026-12-05',
        route: 'Pamba',
        pollSeq: i,
        state: 'FULL',
      });
    }

    expect(orchestrator.getTelemetryQueueLength()).toBe(maxSize);
    const queue = orchestrator.getQueuedTelemetry();
    // Oldest 15 events (1..15) were dropped; queue should start at pollSeq 16
    expect(queue[0].pollSeq).toBe(16);
    expect(queue[queue.length - 1].pollSeq).toBe(maxSize + 15);

    orchestrator.stop();
  });

  it('4. Graceful shutdown with pending telemetry: flushes remaining queue within bounded timeout', async () => {
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 100, 100);

    orchestrator.recordTelemetry({
      demandKey: '2026-12-05_Pamba',
      date: '2026-12-05',
      route: 'Pamba',
      pollSeq: 99,
      state: 'FULL',
    });
    orchestrator.recordTelemetry({
      demandKey: '2026-12-05_Pamba',
      date: '2026-12-05',
      route: 'Pamba',
      pollSeq: 100,
      state: 'AVAILABLE',
    });

    expect(orchestrator.getTelemetryQueueLength()).toBe(2);

    // Call flushTelemetry during shutdown
    await orchestrator.flushTelemetry(2000);

    expect(orchestrator.getTelemetryQueueLength()).toBe(0);
    expect(mockApiClient.sendPollEvents).toHaveBeenCalledTimes(1);
    expect(mockApiClient.sendPollEvents.mock.calls[0][0].events.length).toBe(2);

    orchestrator.stop();
  });

  it('5. Worker restart with new session ID: new process generates a distinct session ID', () => {
    const process1 = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 100, 100);
    const session1 = process1.getWorkerSessionId();
    process1.stop();

    const process2 = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 100, 100);
    const session2 = process2.getWorkerSessionId();
    process2.stop();

    expect(session1).toBeTruthy();
    expect(session2).toBeTruthy();
    expect(session1).not.toBe(session2);
    expect(session1).not.toBe('default');
    expect(session2).not.toBe('default');
  });
});
