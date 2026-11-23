import { SabarimalaDarshanAvailabilityFlow, CheckResult } from './darshan-availability';
import { PlaywrightSabarimalaAdapter } from './sabarimala-adapter';
import { SanitizedLogger } from '../monitoring/logger';
import { WorkerOrchestrator } from '../worker/orchestrator';
import { ContextManager } from '../browser/context-manager';

describe('SabarimalaDarshanAvailabilityFlow – Live Fresh Availability Monitoring', () => {
  let mockPage: any;
  let mockContext: any;
  let responseListeners: Array<(resp: any) => void> = [];

  const setupMockCalendar = (options: {
    displayedMonth?: string;
    displayedYear?: string;
    isDayDisabled?: boolean;
    dayNum?: number;
    calendarVisible?: boolean;
  } = {}) => {
    const {
      displayedMonth = 'JANUARY',
      displayedYear = '2027',
      isDayDisabled = true,
      dayNum = 6,
      calendarVisible = true,
    } = options;

    mockPage.locator.mockImplementation((selector: string) => {
      if (selector === '.mat-calendar, mat-calendar') {
        const calObj = {
          isVisible: jest.fn().mockResolvedValue(calendarVisible),
          waitFor: jest.fn().mockResolvedValue(undefined),
          count: jest.fn().mockResolvedValue(calendarVisible ? 1 : 0),
        };
        return {
          ...calObj,
          first: () => calObj,
        };
      }
      if (selector.includes('Open calendar') || selector.includes('mat-datepicker-toggle')) {
        const toggleObj = {
          waitFor: jest.fn().mockResolvedValue(undefined),
          click: jest.fn().mockResolvedValue(undefined),
          count: jest.fn().mockResolvedValue(1),
          isVisible: jest.fn().mockResolvedValue(true),
        };
        return {
          ...toggleObj,
          first: () => toggleObj,
        };
      }
      if (selector === '.mat-calendar-period-button') {
        const periodObj = {
          textContent: jest.fn().mockResolvedValue(`${displayedMonth} ${displayedYear}`),
          isVisible: jest.fn().mockResolvedValue(true),
          count: jest.fn().mockResolvedValue(1),
        };
        return {
          ...periodObj,
          first: () => periodObj,
        };
      }
      if (selector === '.mat-calendar-body-cell') {
        const matchingCell = {
          textContent: jest.fn().mockResolvedValue(String(dayNum)),
          getAttribute: jest.fn(async (attr: string) => {
            if (attr === 'class') return isDayDisabled ? 'mat-calendar-body-cell mat-calendar-body-disabled' : 'mat-calendar-body-cell';
            if (attr === 'aria-disabled') return isDayDisabled ? 'true' : 'false';
            return null;
          }),
        };
        return {
          count: jest.fn().mockResolvedValue(1),
          nth: jest.fn().mockReturnValue(matchingCell),
          first: () => matchingCell,
        };
      }
      if (selector === '.mat-calendar-next-button') {
        const nextObj = {
          isDisabled: jest.fn().mockResolvedValue(false),
          click: jest.fn().mockResolvedValue(undefined),
          count: jest.fn().mockResolvedValue(1),
        };
        return {
          ...nextObj,
          first: () => nextObj,
        };
      }
      if (selector === '.mat-calendar-previous-button') {
        const prevObj = {
          isDisabled: jest.fn().mockResolvedValue(false),
          click: jest.fn().mockResolvedValue(undefined),
          count: jest.fn().mockResolvedValue(1),
        };
        return {
          ...prevObj,
          first: () => prevObj,
        };
      }
      return {
        first: () => ({
          isVisible: jest.fn().mockResolvedValue(false),
          count: jest.fn().mockResolvedValue(0),
        }),
        count: jest.fn().mockResolvedValue(0),
      };
    });
  };

  beforeEach(() => {
    responseListeners = [];
    const emitDefaultApiResponse = () => {
      responseListeners.forEach((l) => {
        try {
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => ({
              startAndEndDates: ['2026-11-24', '2027-03-13'],
              availableDatesList: [],
              bookedDates: ['2027-01-06', '2027-01-07', '2027-02-15'],
              blockedDates: [],
            }),
          });
        } catch (_) {}
      });
    };

    mockPage = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability'),
      goto: jest.fn(async () => {
        emitDefaultApiResponse();
        return { status: () => 200 };
      }),
      reload: jest.fn(async () => {
        emitDefaultApiResponse();
        return { status: () => 200 };
      }),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, cb: any) => {
        if (event === 'response') responseListeners.push(cb);
      }),
      off: jest.fn((event: string, cb: any) => {
        if (event === 'response') {
          responseListeners = responseListeners.filter((l) => l !== cb);
        }
      }),
      locator: jest.fn(),
      isClosed: jest.fn().mockReturnValue(false),
      title: jest.fn().mockResolvedValue('Darshan Availability'),
    };

    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
    };

    jest.spyOn(ContextManager, 'createIsolatedContext').mockResolvedValue({
      context: mockContext,
      page: mockPage,
    });

    setupMockCalendar();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------
  // Test 1: Initial Page Navigation
  // -------------------------------------------------------------
  it('1. Initial page navigation: calls page.goto and logs initial initialization when not on URL', async () => {
    mockPage.url.mockReturnValue('about:blank');
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });
    const infoSpy = jest.spyOn(SanitizedLogger, 'info');

    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );

    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://sabarimalaonline.org/#/darshanAvailability',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(result.isInitialLoad).toBe(true);
    expect(result.isPageReused).toBe(false);
    expect(result.freshnessConfirmed).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Initial page initialized');
  });

  // -------------------------------------------------------------
  // Test 2: Subsequent Fresh-Data Refresh
  // -------------------------------------------------------------
  it('2. Subsequent fresh-data refresh: reuses existing page and calls page.reload', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });
    const infoSpy = jest.spyOn(SanitizedLogger, 'info');

    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { pollSeq: 2, previousState: 'FULL' },
    );

    expect(mockPage.reload).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(mockPage.goto).not.toHaveBeenCalled();
    expect(result.isPageReused).toBe(true);
    expect(result.freshnessConfirmed).toBe(true);
    expect(result.state).toBe('FULL');
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Existing browser page reused');
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Fresh availability refresh started');
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Fresh network response received');
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] HTTP status=200');
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] No availability change');
  });

  // -------------------------------------------------------------
  // Test 3: FULL to AVAILABLE Transition
  // -------------------------------------------------------------
  it('3. FULL to AVAILABLE transition: detects slot opening and logs transition', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: false, dayNum: 6 });
    const infoSpy = jest.spyOn(SanitizedLogger, 'info');

    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: ['2027-01-06'],
            bookedDates: [],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { pollSeq: 5, previousState: 'FULL' },
    );

    expect(result.state).toBe('AVAILABLE');
    expect(result.available).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Availability transition detected');
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Previous state=FULL');
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Current state=AVAILABLE');
  });

  // -------------------------------------------------------------
  // Test 4: Repeated Polling Without Stale DOM Reuse
  // -------------------------------------------------------------
  it('4. Repeated polling without stale DOM reuse: each poll reloads and records fresh network timestamp', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });

    const poll1 = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { pollSeq: 1, previousState: 'FULL' },
    );

    const poll2 = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { pollSeq: 2, previousState: 'FULL' },
    );

    expect(mockPage.reload).toHaveBeenCalledTimes(2);
    expect(poll1.freshnessConfirmed).toBe(true);
    expect(poll2.freshnessConfirmed).toBe(true);
    expect(poll2.networkResponseTs).toBeGreaterThanOrEqual(poll1.networkResponseTs!);
  });

  // -------------------------------------------------------------
  // Test 5: HTTP 429 and 403 Handling
  // -------------------------------------------------------------
  it('5. HTTP 429 and 403 handling: correctly returns RATE_LIMITED and BLOCKED from network status', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');

    // Test 429
    mockPage.reload.mockResolvedValueOnce({ status: () => 429 });
    const res429 = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );
    expect(res429.state).toBe('RATE_LIMITED');
    expect(res429.httpStatus).toBe(429);
    expect(res429.freshnessConfirmed).toBe(true);

    // Test 403
    mockPage.reload.mockResolvedValueOnce({ status: () => 403 });
    const res403 = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );
    expect(res403.state).toBe('BLOCKED');
    expect(res403.httpStatus).toBe(403);
    expect(res403.freshnessConfirmed).toBe(true);
  });

  // -------------------------------------------------------------
  // Test 6: Network Timeout and Recovery
  // -------------------------------------------------------------
  it('6. Network timeout and recovery: returns UNREACHABLE on timeout, recovers on next cycle', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');

    // Simulate timeout
    mockPage.reload.mockRejectedValueOnce(new Error('Navigation timeout of 25000ms exceeded'));
    mockPage.goto.mockRejectedValueOnce(new Error('Navigation timeout of 30000ms exceeded'));

    const errResult = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );
    expect(errResult.state).toBe('UNREACHABLE');
    expect(errResult.freshnessConfirmed).toBe(false);

    // Next cycle recovers
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });
    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: [],
            bookedDates: ['2027-01-06'],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    const recoveryResult = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { previousState: 'UNREACHABLE' },
    );
    expect(recoveryResult.state).toBe('FULL');
    expect(recoveryResult.freshnessConfirmed).toBe(true);
  });

  // -------------------------------------------------------------
  // Test 7: Calendar Month Navigation
  // -------------------------------------------------------------
  it('7. Calendar month navigation: navigates from January to February for a February date', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    let monthState = 'JANUARY';

    setupMockCalendar({
      displayedMonth: monthState,
      displayedYear: '2027',
      isDayDisabled: false,
      dayNum: 15,
    });

    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: ['2027-02-15'],
            bookedDates: [],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    mockPage.locator.mockImplementation((selector: string) => {
      if (selector === '.mat-calendar, mat-calendar') {
        const cal = {
          isVisible: jest.fn().mockResolvedValue(true),
          waitFor: jest.fn().mockResolvedValue(undefined),
          count: jest.fn().mockResolvedValue(1),
        };
        return { ...cal, first: () => cal };
      }
      if (selector.includes('Open calendar') || selector.includes('mat-datepicker-toggle')) {
        const toggle = {
          waitFor: jest.fn().mockResolvedValue(undefined),
          click: jest.fn().mockResolvedValue(undefined),
          count: jest.fn().mockResolvedValue(1),
        };
        return { ...toggle, first: () => toggle };
      }
      if (selector === '.mat-calendar-period-button') {
        const period = {
          textContent: jest.fn().mockImplementation(async () => `${monthState} 2027`),
          isVisible: jest.fn().mockResolvedValue(true),
          count: jest.fn().mockResolvedValue(1),
        };
        return { ...period, first: () => period };
      }
      if (selector === '.mat-calendar-next-button') {
        const next = {
          isDisabled: jest.fn().mockResolvedValue(false),
          click: jest.fn().mockImplementation(async () => {
            monthState = 'FEBRUARY';
          }),
          count: jest.fn().mockResolvedValue(1),
        };
        return { ...next, first: () => next };
      }
      if (selector === '.mat-calendar-body-cell') {
        const cell = {
          textContent: jest.fn().mockResolvedValue('15'),
          getAttribute: jest.fn(async (attr: string) => (attr === 'class' ? 'mat-calendar-body-cell' : 'false')),
        };
        return {
          count: jest.fn().mockResolvedValue(1),
          nth: () => cell,
          first: () => cell,
        };
      }
      return {
        first: () => ({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) }),
        count: jest.fn().mockResolvedValue(0),
      };
    });

    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-02-15',
    );

    expect(result.state).toBe('AVAILABLE');
    expect(result.displayedMonth).toBe('FEBRUARY');
    expect(result.displayedYear).toBe('2027');
  });

  // -------------------------------------------------------------
  // Test 8: Multiple Dates Sequenced Correctly
  // -------------------------------------------------------------
  it('8. Multiple dates: correctly checks distinct dates in consecutive polls', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });

    const date1Res = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { pollSeq: 1 },
    );
    expect(date1Res.state).toBe('FULL');

    setupMockCalendar({ isDayDisabled: false, dayNum: 7 });
    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: ['2027-01-07'],
            bookedDates: ['2027-01-06'],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    const date2Res = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-07',
      { pollSeq: 2 },
    );
    expect(date2Res.state).toBe('AVAILABLE');
  });

  // -------------------------------------------------------------
  // Test 9: Multiple Routes Route-Specific Tracking
  // -------------------------------------------------------------
  it('9. Multiple routes: preserves route context in check result', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });

    const pambaRes = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { route: 'PAMBA' },
    );
    expect(pambaRes.route).toBe('PAMBA');

    const tradRes = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { route: 'TRADITIONAL' },
    );
    expect(tradRes.route).toBe('TRADITIONAL');
  });

  // -------------------------------------------------------------
  // Test 10: Shared-Page Serialization via withPageLock
  // -------------------------------------------------------------
  it('10. Shared-page serialization: withPageLock guarantees sequential execution on shared adapter', async () => {
    const adapter = new PlaywrightSabarimalaAdapter();
    (adapter as any).page = mockPage;
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });

    let activeOperations = 0;
    let maxConcurrency = 0;

    const op1 = adapter.withPageLock(async () => {
      activeOperations++;
      maxConcurrency = Math.max(maxConcurrency, activeOperations);
      await new Promise((r) => setTimeout(r, 40));
      activeOperations--;
      return 'op1';
    });

    const op2 = adapter.withPageLock(async () => {
      activeOperations++;
      maxConcurrency = Math.max(maxConcurrency, activeOperations);
      await new Promise((r) => setTimeout(r, 40));
      activeOperations--;
      return 'op2';
    });

    const results = await Promise.all([op1, op2]);
    expect(results).toEqual(['op1', 'op2']);
    expect(maxConcurrency).toBe(1); // Strict serialization: never 2
  });

  // -------------------------------------------------------------
  // Test 11: Duplicate Notification Prevention
  // -------------------------------------------------------------
  it('11. Duplicate notification prevention: does not log transition when state remains AVAILABLE', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: false, dayNum: 6 });
    const infoSpy = jest.spyOn(SanitizedLogger, 'info');

    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: ['2027-01-06'],
            bookedDates: [],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
      { previousState: 'AVAILABLE' },
    );

    const transitionLogs = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('Availability transition detected'));

    expect(transitionLogs.length).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] No availability change');
  });

  // -------------------------------------------------------------
  // Test 12: Browser Restart / Recovery on Crash
  // -------------------------------------------------------------
  it('12. Browser restart recovery: creates a fresh adapter when existing page is closed', async () => {
    const mockApiClient: any = { getDemandDates: jest.fn().mockResolvedValue([]) };
    const mockHeartbeat: any = { isExecutionPermitted: () => false, isDiscoveryPermitted: () => true };
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 100);

    const deadAdapter: any = {
      getPage: () => ({ isClosed: () => true }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (orchestrator as any).persistentDiscoveryAdapter = deadAdapter;

    // ensureDiscoveryAdapter detects page isClosed() and creates a fresh instance
    const freshAdapter = await orchestrator.ensureDiscoveryAdapter();
    expect(freshAdapter).toBeDefined();
    expect(deadAdapter.close).toHaveBeenCalled();
    orchestrator.stop();
  });

  // -------------------------------------------------------------
  // Test 13: Monitor-Only Execution Protection
  // -------------------------------------------------------------
  it('13. Monitor-only execution protection: blocks booking execution when MAX_ACTIVE_BOOKINGS=0', async () => {
    const mockApiClient: any = {
      getDemandDates: jest.fn().mockResolvedValue([
        { demandKey: '2027-01-06:PAMBA', date: '2027-01-06', route: 'PAMBA', pendingCount: 1 },
      ]),
      claimJob: jest.fn(),
    };
    const mockHeartbeat: any = {
      isExecutionPermitted: () => false,
      isDiscoveryPermitted: () => true,
      setStatus: jest.fn(),
    };
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 50);
    (orchestrator as any).maxActiveBookings = 0; // Strictly Monitor-Only

    // Spy availability check to return AVAILABLE
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'AVAILABLE',
      available: true,
    });

    const infoSpy = jest.spyOn(SanitizedLogger, 'info');
    const warnSpy = jest.spyOn(SanitizedLogger, 'warn');

    await orchestrator.start();
    await new Promise((r) => setTimeout(r, 120));
    orchestrator.stop();

    // Verify claimJob was NEVER called
    expect(mockApiClient.claimJob).not.toHaveBeenCalled();

    // Verify monitor-only prohibition logs appeared
    expect(infoSpy).toHaveBeenCalledWith('[MONITOR] Booking execution prohibited: monitor-only mode');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('step=BOOKING execution prohibited (capacity: 0, permitted: false)'),
    );
  });

  // -------------------------------------------------------------
  // Test 14: Strict Freshness Gate – Reject Unverified API Response
  // -------------------------------------------------------------
  it('14. Strict freshness gate: returns UNKNOWN when only HTML document HTTP 200 is received without availability API response', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });
    const warnSpy = jest.spyOn(SanitizedLogger, 'warn');

    // Override reload to NOT emit any API response (only document HTTP 200)
    mockPage.reload = jest.fn(async () => {
      // Only emit top-level document response
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/',
          status: () => 200,
          request: () => ({ resourceType: () => 'document' }),
        }),
      );
      return { status: () => 200 };
    });

    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );

    // Mandate: Do not mark freshnessConfirmed=true merely because page reload returned HTTP 200.
    // If the actual availability response cannot be verified, return UNKNOWN rather than FULL or AVAILABLE.
    expect(result.state).toBe('UNKNOWN');
    expect(result.available).toBe(false);
    expect(result.freshnessConfirmed).toBe(false);
    expect(result.apiOutcome).toBe('API_NOT_RECEIVED');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('API_NOT_RECEIVED'),
    );
  });

  // -------------------------------------------------------------
  // Test 15: Freshness Confirmed on Verified Availability API Response
  // -------------------------------------------------------------
  it('15. Freshness confirmed: marks freshnessConfirmed=true and inspects state when availability API response is verified', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    setupMockCalendar({ isDayDisabled: false, dayNum: 6 });

    // Emit verified API response with matching payload
    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: ['2027-01-06'],
            bookedDates: [],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );

    expect(result.state).toBe('AVAILABLE');
    expect(result.available).toBe(true);
    expect(result.freshnessConfirmed).toBe(true);
    expect(result.apiEndpoint).toBe('https://sabarimalaonline.org/api/eDarshan/darshansummary/100001');
    expect(result.apiAvailabilitySummary?.isAvailableInApi).toBe(true);
    expect(result.apiOutcome).toBe('API_VERIFIED');
  });

  // -------------------------------------------------------------
  // Test 16: API Rate Limited (429) & Blocked (403) from API Stream
  // -------------------------------------------------------------
  it('16. API error stream handling: captures HTTP 429 and 403 on API responses', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');

    // Simulate 429 on API response
    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 429,
          request: () => ({ resourceType: () => 'xhr' }),
        }),
      );
      return { status: () => 200 };
    });

    const res429 = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );
    expect(res429.state).toBe('RATE_LIMITED');
    expect(res429.httpStatus).toBe(429);
    expect(res429.freshnessConfirmed).toBe(true);
    expect(res429.apiOutcome).toBe('API_ERROR');
  });

  // -------------------------------------------------------------
  // Test 17: Date Mismatch / Outside Season Window
  // -------------------------------------------------------------
  it('17. Date mismatch handling: returns UNKNOWN when requested date is outside official season window', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');

    // Verified API returns season from 2026-11-24 to 2027-03-13
    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: [],
            bookedDates: ['2027-01-06'],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    // Check date 2028-05-10 which is outside official season window
    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2028-05-10',
    );

    expect(result.state).toBe('UNKNOWN');
    expect(result.available).toBe(false);
    expect(result.freshnessConfirmed).toBe(false);
    expect(result.apiOutcome).toBe('API_DATE_MISMATCH');
    expect(result.reason).toContain('outside official season window');
  });

  // -------------------------------------------------------------
  // Test 18: Authoritative API Reconciliation
  // -------------------------------------------------------------
  it('18. Authoritative API reconciliation: API confirms AVAILABLE even if DOM had disabled attribute', async () => {
    mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
    // Setup DOM with disabled class (stale state)
    setupMockCalendar({ isDayDisabled: true, dayNum: 6 });

    // Official API response arrives with date in availableDatesList
    mockPage.reload = jest.fn(async () => {
      responseListeners.forEach((l) =>
        l({
          url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
          status: () => 200,
          request: () => ({ resourceType: () => 'xhr' }),
          json: async () => ({
            startAndEndDates: ['2026-11-24', '2027-03-13'],
            availableDatesList: ['2027-01-06'],
            bookedDates: [],
            blockedDates: [],
          }),
        }),
      );
      return { status: () => 200 };
    });

    const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
      mockPage,
      '2027-01-06',
    );

    // Verified API availability overrides stale DOM disabled state
    expect(result.state).toBe('AVAILABLE');
    expect(result.available).toBe(true);
    expect(result.freshnessConfirmed).toBe(true);
    expect(result.apiAvailabilitySummary?.isAvailableInApi).toBe(true);
    expect(result.apiOutcome).toBe('API_VERIFIED');
  });

  // =============================================================
  // SECTION 4: STRICT PER-POLL API VALIDATION & OBSERVABILITY (12 REQUIRED TESTS)
  // =============================================================
  describe('Strict Per-Poll API Validation & Fail-Closed Classification (12 Requirements)', () => {
    const validSummaryPayload = {
      startAndEndDates: ['2026-11-24', '2027-03-13'],
      availableDatesList: ['2027-01-10'],
      bookedDates: ['2027-01-06', '2027-01-07'],
      blockedDates: [],
    };

    it('R1. API response received in current cycle: verifies API, logs API_VERIFIED with details', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: true, dayNum: 6 });
      const infoSpy = jest.spyOn(SanitizedLogger, 'info');

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => validSummaryPayload,
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 42, pollStartTs: Date.now() },
      );

      expect(result.apiOutcome).toBe('API_VERIFIED');
      expect(result.freshnessConfirmed).toBe(true);
      expect(result.state).toBe('FULL');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MONITOR] API_VERIFIED endpoint=https://sabarimalaonline.org/api/eDarshan/darshansummary/100001 status=200 pollSeq=42'),
      );
    });

    it('R2. API response missing: returns UNKNOWN, freshnessConfirmed=false, logs API_NOT_RECEIVED', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: true, dayNum: 6 });
      const warnSpy = jest.spyOn(SanitizedLogger, 'warn');

      // Reload emits no response at all
      mockPage.reload = jest.fn(async () => ({ status: () => 200 }));

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 7, apiWaitTimeoutMs: 100 },
      );

      expect(result.apiOutcome).toBe('API_NOT_RECEIVED');
      expect(result.state).toBe('UNKNOWN');
      expect(result.freshnessConfirmed).toBe(false);
      expect(result.available).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MONITOR] API_NOT_RECEIVED endpoint=/api/eDarshan/darshansummary/100001 pollSeq=7'),
      );
    });

    it('R3. Only HTML document HTTP 200 received: returns UNKNOWN without treating HTML 200 as fresh data', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 }); // DOM would look available

      // Reload emits only HTML document HTTP 200
      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/#/darshanAvailability',
            status: () => 200,
            request: () => ({ resourceType: () => 'document' }),
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 8, apiWaitTimeoutMs: 100 },
      );

      // Must fail-closed: do not inspect DOM or produce AVAILABLE
      expect(result.apiOutcome).toBe('API_NOT_RECEIVED');
      expect(result.state).toBe('UNKNOWN');
      expect(result.available).toBe(false);
      expect(result.freshnessConfirmed).toBe(false);
    });

    it('R4. API response delayed beyond timeout: fails closed with UNKNOWN and API_NOT_RECEIVED', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 });

      // Emits response after 300ms, while timeout is set to 100ms
      mockPage.reload = jest.fn(async () => {
        setTimeout(() => {
          responseListeners.forEach((l) =>
            l({
              url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
              status: () => 200,
              request: () => ({ resourceType: () => 'xhr' }),
              json: async () => validSummaryPayload,
            }),
          );
        }, 300);
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 9, apiWaitTimeoutMs: 100 },
      );

      expect(result.apiOutcome).toBe('API_NOT_RECEIVED');
      expect(result.state).toBe('UNKNOWN');
      expect(result.freshnessConfirmed).toBe(false);
    });

    it('R5. API response from a previous cycle: rejects stale response timestamp, returns UNKNOWN', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 });

      // Simulate a cycle starting in the future relative to response timestamp
      const futurePollStartTs = Date.now() + 50000;

      mockPage.reload = jest.fn(async () => {
        // Emits response with current timestamp (which is < futurePollStartTs)
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => validSummaryPayload,
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 10, pollStartTs: futurePollStartTs, apiWaitTimeoutMs: 100 },
      );

      expect(result.apiOutcome).toBe('API_NOT_RECEIVED');
      expect(result.state).toBe('UNKNOWN');
      expect(result.freshnessConfirmed).toBe(false);
    });

    it('R6. Invalid JSON: fails closed with API_INVALID and state UNKNOWN', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 });
      const warnSpy = jest.spyOn(SanitizedLogger, 'warn');

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => {
              throw new Error('Unexpected token < in JSON at position 0');
            },
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 11, apiWaitTimeoutMs: 100 },
      );

      expect(result.apiOutcome).toBe('API_INVALID');
      expect(result.state).toBe('UNKNOWN');
      expect(result.freshnessConfirmed).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MONITOR] API_INVALID'),
      );
    });

    it('R7. Missing availability fields: fails closed with API_INVALID when required fields absent', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 });

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => ({
              // Missing availableDatesList and bookedDates
              startAndEndDates: ['2026-11-24', '2027-03-13'],
            }),
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 12, apiWaitTimeoutMs: 100 },
      );

      expect(result.apiOutcome).toBe('API_INVALID');
      expect(result.state).toBe('UNKNOWN');
      expect(result.freshnessConfirmed).toBe(false);
    });

    it('R8. Requested date outside official season: fails closed with API_DATE_MISMATCH and UNKNOWN', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 });
      const warnSpy = jest.spyOn(SanitizedLogger, 'warn');

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => validSummaryPayload, // 2026-11-24 to 2027-03-13
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2028-01-01',
        { pollSeq: 13, apiWaitTimeoutMs: 100 },
      );

      expect(result.apiOutcome).toBe('API_DATE_MISMATCH');
      expect(result.state).toBe('UNKNOWN');
      expect(result.freshnessConfirmed).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MONITOR] API_DATE_MISMATCH'),
      );
    });

    it('R9. Requested date marked booked: classifies FULL based on API payload', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: true, dayNum: 6 });

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => ({
              startAndEndDates: ['2026-11-24', '2027-03-13'],
              availableDatesList: [],
              bookedDates: ['2027-01-06'],
              blockedDates: [],
            }),
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 14 },
      );

      expect(result.apiOutcome).toBe('API_VERIFIED');
      expect(result.state).toBe('FULL');
      expect(result.available).toBe(false);
      expect(result.freshnessConfirmed).toBe(true);
    });

    it('R10. Requested date marked available: classifies AVAILABLE based on API payload', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 });

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => ({
              startAndEndDates: ['2026-11-24', '2027-03-13'],
              availableDatesList: ['2027-01-06'],
              bookedDates: [],
              blockedDates: [],
            }),
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 15 },
      );

      expect(result.apiOutcome).toBe('API_VERIFIED');
      expect(result.state).toBe('AVAILABLE');
      expect(result.available).toBe(true);
      expect(result.freshnessConfirmed).toBe(true);
    });

    it('R11. DOM says FULL but API says AVAILABLE: API authoritatively overrides to AVAILABLE', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      // DOM has disabled class (would produce FULL if DOM alone was checked)
      setupMockCalendar({ isDayDisabled: true, dayNum: 6 });

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => ({
              startAndEndDates: ['2026-11-24', '2027-03-13'],
              availableDatesList: ['2027-01-06'],
              bookedDates: [],
              blockedDates: [],
            }),
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 16 },
      );

      expect(result.apiOutcome).toBe('API_VERIFIED');
      expect(result.state).toBe('AVAILABLE');
      expect(result.available).toBe(true);
      expect(result.freshnessConfirmed).toBe(true);
    });

    it('R12. DOM says AVAILABLE but API says FULL: API authoritatively overrides to FULL', async () => {
      mockPage.url.mockReturnValue('https://sabarimalaonline.org/#/darshanAvailability');
      // DOM has active / enabled class (would produce AVAILABLE if DOM alone was checked)
      setupMockCalendar({ isDayDisabled: false, dayNum: 6 });

      mockPage.reload = jest.fn(async () => {
        responseListeners.forEach((l) =>
          l({
            url: () => 'https://sabarimalaonline.org/api/eDarshan/darshansummary/100001',
            status: () => 200,
            request: () => ({ resourceType: () => 'xhr' }),
            json: async () => ({
              startAndEndDates: ['2026-11-24', '2027-03-13'],
              availableDatesList: [],
              bookedDates: ['2027-01-06'],
              blockedDates: [],
            }),
          }),
        );
        return { status: () => 200 };
      });

      const result = await SabarimalaDarshanAvailabilityFlow.checkRequestedDateAvailability(
        mockPage,
        '2027-01-06',
        { pollSeq: 17 },
      );

      expect(result.apiOutcome).toBe('API_VERIFIED');
      expect(result.state).toBe('FULL');
      expect(result.available).toBe(false);
      expect(result.freshnessConfirmed).toBe(true);
    });
  });
});
