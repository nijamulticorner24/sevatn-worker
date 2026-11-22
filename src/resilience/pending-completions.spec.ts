import * as fs from 'fs';
import * as path from 'path';
import { PendingCompletionsManager } from './pending-completions';
import { BookingExecutionGuard } from '../security/execution-guard';

describe('PendingCompletionsManager & BookingExecutionGuard', () => {
  const testJobId = 'test-job-999';
  const testBookingId = 'test-req-999';
  const testBookingCode = 'TA-TEST-999';
  const testRef = 'IVQ26112099999999999';

  beforeEach(() => {
    PendingCompletionsManager.clearAll();
    BookingExecutionGuard.clearAll();
  });

  afterEach(() => {
    PendingCompletionsManager.clearAll();
    BookingExecutionGuard.clearAll();
  });

  it('1. Persists pending completion to durable file and loads into memory', () => {
    const filePath = PendingCompletionsManager.savePending({
      jobId: testJobId,
      bookingRequestId: testBookingId,
      bookingCode: testBookingCode,
      officialBookingReference: testRef,
      cartId: '12345678',
    });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(PendingCompletionsManager.hasPending(testJobId)).toBe(true);
    expect(PendingCompletionsManager.hasPending(testBookingId)).toBe(true);
    expect(PendingCompletionsManager.hasPending(testBookingCode)).toBe(true);

    const pending = PendingCompletionsManager.getPending(testJobId);
    expect(pending?.officialBookingReference).toBe(testRef);
    expect(pending?.attempts).toBe(0);
  });

  it('2. Reloads pending completions from disk on startup (reload test)', () => {
    PendingCompletionsManager.savePending({
      jobId: testJobId,
      bookingRequestId: testBookingId,
      bookingCode: testBookingCode,
      officialBookingReference: testRef,
    });

    // Simulate startup by calling loadAll
    const loaded = PendingCompletionsManager.loadAll();
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(loaded.some(item => item.jobId === testJobId)).toBe(true);
    expect(PendingCompletionsManager.hasPending(testBookingCode)).toBe(true);
  });

  it('3. Calculates exponential backoff intervals correctly', () => {
    expect(PendingCompletionsManager.getBackoffDelayMs(1)).toBe(30 * 1000); // 30s
    expect(PendingCompletionsManager.getBackoffDelayMs(2)).toBe(60 * 1000); // 1m
    expect(PendingCompletionsManager.getBackoffDelayMs(3)).toBe(300 * 1000); // 5m
    expect(PendingCompletionsManager.getBackoffDelayMs(4)).toBe(900 * 1000); // 15m
    expect(PendingCompletionsManager.getBackoffDelayMs(5)).toBe(900 * 1000); // 15m
  });

  it('4. Retries pending completions and deletes file upon API success', async () => {
    PendingCompletionsManager.savePending({
      jobId: testJobId,
      bookingRequestId: testBookingId,
      bookingCode: testBookingCode,
      officialBookingReference: testRef,
    });

    const mockApiClient = {
      completeJob: jest.fn().mockResolvedValue({ success: true }),
    };

    await PendingCompletionsManager.processPending(mockApiClient);

    expect(mockApiClient.completeJob).toHaveBeenCalledWith(testJobId, expect.objectContaining({
      officialBookingReference: testRef,
    }));
    expect(PendingCompletionsManager.hasPending(testJobId)).toBe(false);
  });

  it('5. Increments attempts and applies backoff when API fails with 500', async () => {
    PendingCompletionsManager.savePending({
      jobId: testJobId,
      bookingRequestId: testBookingId,
      bookingCode: testBookingCode,
      officialBookingReference: testRef,
    });

    const mockApiClient = {
      completeJob: jest.fn().mockRejectedValue(new Error('Request failed with status code 500')),
    };

    await PendingCompletionsManager.processPending(mockApiClient);

    expect(PendingCompletionsManager.hasPending(testJobId)).toBe(true);
    const pending = PendingCompletionsManager.getPending(testJobId);
    expect(pending?.attempts).toBe(1);
    expect(pending?.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it('6. BookingExecutionGuard strictly BLOCKS re-booking when a pending completion exists', () => {
    PendingCompletionsManager.savePending({
      jobId: testJobId,
      bookingRequestId: testBookingId,
      bookingCode: testBookingCode,
      officialBookingReference: testRef,
    });

    const acquireResult = BookingExecutionGuard.acquire({
      bookingId: testBookingId,
      bookingCode: testBookingCode,
      jobId: 'new-duplicate-job-123',
      dispatchSource: 'SNIPER',
    });

    // Invariant: Must refuse re-booking to prevent duplicate official passes
    expect(acquireResult.acquired).toBe(false);
    expect(BookingExecutionGuard.isBookingPendingCompletion(testBookingCode)).toBe(true);
  });
});
