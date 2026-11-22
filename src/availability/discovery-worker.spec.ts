import { AvailabilityDiscoveryWorker } from './discovery-worker';
import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { AvailabilityCache } from './availability-cache';

jest.mock('../sabarimala/sabarimala-adapter');

describe('AvailabilityDiscoveryWorker Pre-Login Date-Only Discovery Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockAdapter: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApiClient = {
      getDemandDates: jest.fn().mockResolvedValue([
        { date: '2026-10-20', route: 'Pamba - Marakkoottam - 4 Kms', pendingCount: 1 },
      ]),
      publishBulkAvailability: jest.fn().mockResolvedValue([
        { matched: true, bookingId: 'b-001', bookingCode: 'TA-2026-001', message: 'Matched' },
      ]),
    } as any;
    (mockApiClient as any).publishAvailability = mockApiClient.publishBulkAvailability;

    mockAdapter = {
      init: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      openDarshanAvailability: jest.fn().mockResolvedValue({
        success: true,
        url: 'https://sabarimalaonline.org/#/darshanAvailability',
      }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({
        available: true,
        state: 'AVAILABLE',
      }),
      selectRequestedDate: jest.fn().mockResolvedValue({
        success: true,
        selectedDate: '2026-10-20',
      }),
      selectRoute: jest.fn().mockResolvedValue({
        success: true,
        selectedRoute: 'Pamba - Marakkoottam - 4 Kms',
      }),
      discoverAvailableSlots: jest.fn(),
      selectAvailableTimeSlot: jest.fn(),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);
  });

  afterEach(() => {
    delete process.env.DISCOVERY_CONTEXT_RECYCLE_POLLS;
  });

  it('1. Available Date: checks date, selects date & route, publishes date/route event without querying time slots', async () => {
    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient);
    await discoveryWorker.runDiscoveryPass();

    // 1. Must open darshanAvailability
    expect(mockAdapter.openDarshanAvailability).toHaveBeenCalled();

    // 2. Must check calendar for requested date
    expect(mockAdapter.checkRequestedDateAvailability).toHaveBeenCalledWith('2026-10-20');

    // 3. Must select and verify date
    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledWith('2026-10-20');

    // 4. Must select and verify route
    expect(mockAdapter.selectRoute).toHaveBeenCalledWith('Pamba - Marakkoottam - 4 Kms');

    // 5. CRITICAL: Must NOT query or inspect time slots pre-login
    expect(mockAdapter.discoverAvailableSlots).not.toHaveBeenCalled();
    expect(mockAdapter.selectAvailableTimeSlot).not.toHaveBeenCalled();

    // 6. Must publish date-and-route event without fabricating any time slots
    expect(mockApiClient.publishBulkAvailability).toHaveBeenCalledWith([
      expect.objectContaining({
        date: '2026-10-20',
        route: 'Pamba - Marakkoottam - 4 Kms',
      }),
    ]);

    const publishedEvent = mockApiClient.publishBulkAvailability.mock.calls[0][0][0];
    expect((publishedEvent as any).timeSlot).toBeUndefined();
  });

  it('2. Unavailable Date: does not publish an event and leaves request pending', async () => {
    mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
      available: false,
      state: 'DISABLED',
      message: 'Date full',
    });

    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient);
    await discoveryWorker.runDiscoveryPass();

    expect(mockAdapter.checkRequestedDateAvailability).toHaveBeenCalledWith('2026-10-20');

    // Must NOT select date or route
    expect(mockAdapter.selectRequestedDate).not.toHaveBeenCalled();
    expect(mockAdapter.selectRoute).not.toHaveBeenCalled();

    // Must NOT query time slots
    expect(mockAdapter.discoverAvailableSlots).not.toHaveBeenCalled();

    // Must NOT publish any availability events
    expect(mockApiClient.publishBulkAvailability).not.toHaveBeenCalled();
  });

  it('3. Idle Demand: exits cleanly when there are no pending bookings', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([]);

    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient);
    await discoveryWorker.runDiscoveryPass();

    // Should not initialize browser if there are no demand dates
    expect(mockAdapter.init).not.toHaveBeenCalled();
    expect(mockApiClient.publishBulkAvailability).not.toHaveBeenCalled();
  });

  it('4. Matcher Acceptance & Outcome: processes matcher response and logs job creation outcome', async () => {
    mockApiClient.publishBulkAvailability.mockResolvedValue([
      {
        matched: true,
        bookingId: 'book-999',
        bookingCode: 'TA-999',
        message: 'Successfully matched Booking #TA-999 to 2026-10-20 / Pamba',
      },
    ]);

    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient);
    await discoveryWorker.runDiscoveryPass();

    expect(mockApiClient.publishBulkAvailability).toHaveBeenCalled();
    // GAP-02: Persistent adapter reuse — created once, not closed per pass
    expect(mockAdapter.init).toHaveBeenCalledTimes(1);
    expect(mockAdapter.close).not.toHaveBeenCalled();

    // Run a second pass — adapter should still be the same instance
    mockAdapter.init.mockClear();
    await discoveryWorker.runDiscoveryPass();
    expect(mockAdapter.init).not.toHaveBeenCalled();
  });

  it('4b. Recycles persistent context every DISCOVERY_CONTEXT_RECYCLE_POLLS passes', async () => {
    process.env.DISCOVERY_CONTEXT_RECYCLE_POLLS = '3';
    mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
      state: 'FULL',
      observedAt: new Date().toISOString(),
    });

    const worker = new AvailabilityDiscoveryWorker(mockApiClient);
    await worker.runDiscoveryPass(); // pass 1
    await worker.runDiscoveryPass(); // pass 2
    await worker.runDiscoveryPass(); // pass 3 — triggers recycle

    expect(mockAdapter.close).toHaveBeenCalledTimes(1); // exactly once, at recycle
    expect(mockAdapter.init).toHaveBeenCalledTimes(2);  // recreated after recycle
  });

  it('4c. shutdown() closes the persistent context', async () => {
    mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
      state: 'FULL',
      observedAt: new Date().toISOString(),
    });

    const worker = new AvailabilityDiscoveryWorker(mockApiClient);
    await worker.runDiscoveryPass();

    await worker.shutdown();
    expect(mockAdapter.close).toHaveBeenCalledTimes(1);
  });

  it('5. Missing or Unselectable Date: handles selection exception safely without publishing', async () => {
    mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
      available: true,
      state: 'AVAILABLE',
    });
    mockAdapter.selectRequestedDate.mockRejectedValue(new Error('Date cell missing or not clickable'));

    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient);
    await discoveryWorker.runDiscoveryPass();

    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledWith('2026-10-20');
    expect(mockAdapter.selectRoute).not.toHaveBeenCalled();
    expect(mockApiClient.publishBulkAvailability).not.toHaveBeenCalled();
    expect(mockAdapter.init).toHaveBeenCalledTimes(1);
    expect(mockAdapter.close).not.toHaveBeenCalled();
  });

  it('6. Route Selection Failure: handles route failure safely without publishing', async () => {
    mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
      available: true,
      state: 'AVAILABLE',
    });
    mockAdapter.selectRoute.mockRejectedValue(new Error('Route dropdown missing'));

    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient);
    await discoveryWorker.runDiscoveryPass();

    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledWith('2026-10-20');
    expect(mockAdapter.selectRoute).toHaveBeenCalledWith('Pamba - Marakkoottam - 4 Kms');
    expect(mockApiClient.publishBulkAvailability).not.toHaveBeenCalled();
    expect(mockAdapter.init).toHaveBeenCalledTimes(1);
    expect(mockAdapter.close).not.toHaveBeenCalled();
  });

  it('7. Multiple Demand Dates: publishes only verified dates and skips unavailable ones', async () => {
    mockApiClient.getDemandDates.mockResolvedValue([
      { date: '2026-10-20', route: 'Pamba - Marakkoottam - 4 Kms', pendingCount: 1 },
      { date: '2026-10-25', route: 'Erumeli Route', pendingCount: 2 },
    ]);

    mockAdapter.checkRequestedDateAvailability.mockImplementation(async (date: string) => {
      if (date === '2026-10-20') return { available: true, state: 'AVAILABLE' };
      return { available: false, state: 'DISABLED' };
    });

    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient);
    await discoveryWorker.runDiscoveryPass();

    expect(mockApiClient.publishBulkAvailability).toHaveBeenCalledTimes(1);
    const publishedList = mockApiClient.publishBulkAvailability.mock.calls[0][0];
    expect(publishedList).toHaveLength(1);
    expect(publishedList[0].date).toBe('2026-10-20');
    expect(publishedList[0].timeSlot).toBeUndefined();
    expect(mockAdapter.init).toHaveBeenCalledTimes(1);
    expect(mockAdapter.close).not.toHaveBeenCalled();
  });

  it('8. Cancellation Sniping: when date is available, calls matchPending and invokes onBookingSniped callback', async () => {
    (mockApiClient as any).matchPending = jest.fn().mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: { id: 'sniped-job-1', bookingCode: 'TA-SNIPED-01', requestedDate: '2026-10-20' },
    });

    const onBookingSnipedMock = jest.fn();
    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient, onBookingSnipedMock);
    await discoveryWorker.runDiscoveryPass();

    expect(discoveryWorker.availableDatesSet.has('2026-10-20')).toBe(true);
    expect((mockApiClient as any).matchPending).toHaveBeenCalledWith('2026-10-20', 'Pamba - Marakkoottam - 4 Kms');
    expect(onBookingSnipedMock).toHaveBeenCalledWith('BOOKING_EXECUTION', expect.objectContaining({ id: 'sniped-job-1' }));
  });

  it('8b. Cancellation Sniping: when matchPending refuses with specific reason, logs reason and emits slot:opened', async () => {
    (mockApiClient as any).matchPending = jest.fn().mockResolvedValue({
      hasJob: false,
      reason: 'ROUTE_MISMATCH',
      message: 'No claimable booking for date 2026-10-20 (ROUTE_MISMATCH)',
    });

    const onBookingSnipedMock = jest.fn();
    const discoveryWorker = new AvailabilityDiscoveryWorker(mockApiClient, onBookingSnipedMock);
    const slotOpenedSpy = jest.fn();
    discoveryWorker.on('slot:opened', slotOpenedSpy);

    await discoveryWorker.runDiscoveryPass();

    expect((mockApiClient as any).matchPending).toHaveBeenCalledWith('2026-10-20', 'Pamba - Marakkoottam - 4 Kms');
    expect(onBookingSnipedMock).not.toHaveBeenCalled();
    expect(slotOpenedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-10-20', route: 'Pamba - Marakkoottam - 4 Kms' }),
    );
  });

  it('9a. No backoff on FULL — FULL is a valid state, re-checked on next pass', async () => {
    mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
      state: 'FULL',
      observedAt: new Date().toISOString(),
    });

    const worker = new AvailabilityDiscoveryWorker(mockApiClient);
    await worker.runDiscoveryPass();

    // GAP-01: FULL does NOT trigger backoff
    expect(worker['failedDateBackoffMap'].has('2026-10-20')).toBe(false);
    expect(worker['availableDatesSet'].has('2026-10-20')).toBe(false);

    // Next pass DOES re-check (no skip)
    mockAdapter.checkRequestedDateAvailability.mockClear();
    await worker.runDiscoveryPass();
    expect(mockAdapter.checkRequestedDateAvailability).toHaveBeenCalledWith('2026-10-20');
  });

  it('9b. Backoff on RATE_LIMITED (429) — 60s backoff and skip next pass', async () => {
    mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
      state: 'RATE_LIMITED',
      httpStatus: 429,
      observedAt: new Date().toISOString(),
    });

    const worker = new AvailabilityDiscoveryWorker(mockApiClient);
    const before = Date.now();
    await worker.runDiscoveryPass();

    const until = worker['failedDateBackoffMap'].get('2026-10-20');
    expect(until).toBeGreaterThanOrEqual(before + 59000);
    expect(until).toBeLessThanOrEqual(before + 61000);

    mockAdapter.init.mockClear();
    mockAdapter.checkRequestedDateAvailability.mockClear();
    await worker.runDiscoveryPass();
    expect(mockAdapter.init).not.toHaveBeenCalled(); // still backed off
    expect(mockAdapter.checkRequestedDateAvailability).not.toHaveBeenCalled();
  });

  it('9c. No backoff on FULL→AVAILABLE transition — publishes availability', async () => {
    mockAdapter.checkRequestedDateAvailability
      .mockResolvedValueOnce({ state: 'FULL', observedAt: new Date().toISOString() })
      .mockResolvedValueOnce({ state: 'AVAILABLE', observedAt: new Date().toISOString() });

    const worker = new AvailabilityDiscoveryWorker(mockApiClient);
    await worker.runDiscoveryPass();
    await worker.runDiscoveryPass();

    expect(worker['availableDatesSet'].has('2026-10-20')).toBe(true);
    expect(mockApiClient.publishBulkAvailability).toHaveBeenCalled();
  });

  describe('PR #4: AvailabilityCache & slot:opened Event Trigger', () => {
    it('10. Discovery pass writes availability state to AvailabilityCache', async () => {
      mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
        state: 'AVAILABLE',
        observedAt: new Date().toISOString(),
      });

      const cache = AvailabilityCache.getInstance();
      cache.clear();

      const worker = new AvailabilityDiscoveryWorker(mockApiClient, undefined, cache);
      await worker.runDiscoveryPass();

      const key = AvailabilityCache.buildKey('2026-10-20', 'Pamba - Marakkoottam - 4 Kms');
      const cached = cache.get(key);
      expect(cached).toBeDefined();
      expect(cached?.state).toBe('AVAILABLE');
    });

    it('11. FULL -> AVAILABLE transition emits slot:opened event with { date, route }', async () => {
      mockAdapter.checkRequestedDateAvailability
        .mockResolvedValueOnce({ state: 'FULL', observedAt: new Date().toISOString() })
        .mockResolvedValueOnce({ state: 'AVAILABLE', observedAt: new Date().toISOString() });

      const cache = AvailabilityCache.getInstance();
      cache.clear();

      const worker = new AvailabilityDiscoveryWorker(mockApiClient, undefined, cache);
      const slotOpenedSpy = jest.fn();
      worker.on('slot:opened', slotOpenedSpy);

      // Pass 1: FULL
      await worker.runDiscoveryPass();
      expect(slotOpenedSpy).not.toHaveBeenCalled();

      // Pass 2: AVAILABLE (transition from FULL -> AVAILABLE)
      await worker.runDiscoveryPass();
      expect(slotOpenedSpy).toHaveBeenCalledTimes(1);
      expect(slotOpenedSpy).toHaveBeenCalledWith({
        date: '2026-10-20',
        route: 'Pamba - Marakkoottam - 4 Kms',
      });
    });

    it('12. Watches registered RETRYABLE_FAILURE demands so engine never goes idle', async () => {
      // API returns no pending dates
      mockApiClient.getDemandDates.mockResolvedValue([]);
      if (typeof (mockApiClient as any).getPendingDates === 'function') {
        (mockApiClient as any).getPendingDates.mockResolvedValue({ dates: [] });
      }

      const worker = new AvailabilityDiscoveryWorker(mockApiClient);
      // Register retryable failure demand
      worker.registerRetryableDemand('2026-11-25', 'Pamba - Marakkoottam - 4 Kms');

      mockAdapter.checkRequestedDateAvailability.mockResolvedValue({
        state: 'FULL',
        observedAt: new Date().toISOString(),
      });

      await worker.runDiscoveryPass();

      // Browser check must run for the retryable demand
      expect(mockAdapter.checkRequestedDateAvailability).toHaveBeenCalledWith('2026-11-25');
    });
  });

  describe('PR #5: Watcher Scheduler Alignment', () => {
    it('schedules nextDueAt from AVAILABILITY_POLL_INTERVAL_MS, not a hardcoded value', async () => {
      process.env.AVAILABILITY_POLL_INTERVAL_MS = '3000';
      process.env.AVAILABILITY_POLL_JITTER_MS = '0';

      const worker = new AvailabilityDiscoveryWorker(mockApiClient);
      const before = Date.now();
      await worker.runDiscoveryPass();
      const nextDue = (worker as any).nextDueAt;

      // Must be within 3-4 seconds, NOT 30 seconds
      expect(nextDue).toBeGreaterThanOrEqual(before + 2900);
      expect(nextDue).toBeLessThanOrEqual(before + 3100);

      delete process.env.AVAILABILITY_POLL_INTERVAL_MS;
      delete process.env.AVAILABILITY_POLL_JITTER_MS;
    });
  });
});

