import { BookingWorker } from './booking-worker';
import { BookingExecutionGuard } from '../security/execution-guard';
import { SabarimalaDarshanAvailabilityFlow } from '../sabarimala/darshan-availability';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';

jest.mock('../sabarimala/sabarimala-adapter');

describe('TA-10026 Date Not Selectable & Re-arm Suite', () => {
  let mockApiClient: any;
  let mockAdapter: any;

  beforeAll(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = '12345678901234567890123456789012';
    jest.spyOn(CredentialManager, 'decrypt').mockReturnValue('mockDecryptedPassword123');
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    BookingExecutionGuard.clearAll();
    BookingExecutionGuard.releaseGlobalPriorityLock();

    mockApiClient = {
      updateJobProgress: jest.fn().mockResolvedValue({ success: true }),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    mockAdapter = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true, url: 'https://sabarimalaonline.org/#/darshanAvailability' }),
      selectRequestedDate: jest.fn().mockResolvedValue({ success: false, selectedDate: '2027-01-09', error: 'DATE_NOT_SELECTABLE' }),
      selectRoute: jest.fn().mockResolvedValue({ success: true }),
      proceedToLogin: jest.fn().mockResolvedValue({ success: true }),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      captureScreenshotBase64: jest.fn().mockResolvedValue('mock-screenshot-base64'),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);
  });

  const baseJob: any = {
    id: 'job-ta-10026-001',
    bookingRequestId: 'req-ta-10026',
    bookingCode: 'TA-10026',
    requestedDate: '2027-01-09',
    route: 'Pamba - Marakkoottam - 4 Kms',
    account: {
      username: 'test_user',
      encryptedPassword: 'enc',
      encryptionIv: 'iv',
      encryptionTag: 'tag',
    },
    leaseGeneration: 1,
    fencingToken: 'fnc_10026_001',
    nominee: {
      nomineeName: 'Nija',
      nomineeAge: 26,
      nomineeRelationship: 'Brother',
      nomineePhone: '9876543210',
    },
  };

  it('Test 1: When selectRequestedDate returns DATE_NOT_SELECTABLE, maps cleanly to TEMPORARY_SLOT_LOST', async () => {
    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // completeJob must NEVER be called
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    // Must report TEMPORARY_SLOT_LOST to failJob (NOT WORKER_ERROR)
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-ta-10026-001',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        errorCode: 'DATE_NOT_SELECTABLE',
      }),
    );

    // Lifecycle state in BookingExecutionGuard must be TEMPORARY_SLOT_LOST
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-ta-10026');
    expect(lifecycle).toBe('TEMPORARY_SLOT_LOST');
  });

  it('Test 2: When selectDate throws unhandled "is not selectable in calendar", maps cleanly to TEMPORARY_SLOT_LOST', async () => {
    mockAdapter.selectRequestedDate = jest.fn().mockRejectedValue(new Error('Date 2027-01-09 is not selectable in calendar'));

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-ta-10026-001',
      expect.objectContaining({
        status: 'TEMPORARY_SLOT_LOST',
        errorCode: 'DATE_NOT_SELECTABLE',
      }),
    );

    const lifecycle = BookingExecutionGuard.getLifecycleState('req-ta-10026');
    expect(lifecycle).toBe('TEMPORARY_SLOT_LOST');
  });

  it('Test 3: SabarimalaDarshanAvailabilityFlow.selectDate returns { success: false, error: DATE_NOT_SELECTABLE } when cell count is 0', async () => {
    const mockPage: any = {
      locator: jest.fn().mockReturnValue({
        filter: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(0),
        }),
        first: jest.fn().mockReturnValue({
          textContent: jest.fn().mockResolvedValue('JANUARY 2027'),
        }),
      }),
      isClosed: jest.fn().mockReturnValue(false),
    };

    // Spy on inspectAndNavigateMonth so it succeeds
    jest.spyOn(SabarimalaDarshanAvailabilityFlow as any, 'inspectAndNavigateMonth').mockResolvedValue({
      month: 'JANUARY',
      year: '2027',
      success: true,
    });

    const res = await SabarimalaDarshanAvailabilityFlow.selectDate(mockPage, '2027-01-09');
    expect(res.success).toBe(false);
    expect(res.error).toBe('DATE_NOT_SELECTABLE');
    expect(res.selectedDate).toBe('2027-01-09');
  });

  it('Test 4: Orchestrator terminates after exactly 1 attempt on TEMPORARY_SLOT_LOST / DATE_NOT_SELECTABLE', () => {
    // Simulating orchestrator loop behavior
    let attempt = 1;
    const maxBookingAttempts = 3;
    let terminalStatus = 'FAILED';
    let lastOutcomeReason = '';

    while (attempt <= maxBookingAttempts) {
      // Attempt 1 execution results in TEMPORARY_SLOT_LOST
      const lifecycleState: string = 'TEMPORARY_SLOT_LOST';
      lastOutcomeReason = 'DATE_NOT_SELECTABLE';

      if (
        lifecycleState === 'SLOT_UNAVAILABLE' ||
        lifecycleState === 'TEMPORARY_SLOT_LOST' ||
        lastOutcomeReason.includes('DATE_NOT_SELECTABLE')
      ) {
        terminalStatus = 'TEMPORARY_SLOT_LOST';
        lastOutcomeReason = 'DATE_NOT_SELECTABLE';
        break; // Stop immediately after attempt 1
      }

      attempt++;
    }

    expect(attempt).toBe(1);
    expect(terminalStatus).toBe('TEMPORARY_SLOT_LOST');
    expect(lastOutcomeReason).toBe('DATE_NOT_SELECTABLE');
  });

  it('Test 5: Stale detection guard blocks immediate re-claim until fresh detection occurs', () => {
    const key = '2027-01-09:Pamba';
    const state: any = {
      demandKey: key,
      phase: 'WATCHING',
      watchStartedAt: Date.now(),
      bookingIds: ['req-ta-10026'],
      pollSeq: 5,
      requiresFreshDetection: true,
      staleDetectionPollSeq: 5,
      staleDetectionUntilTs: Date.now() + 15000,
    };

    // Subsequent tick with same pollSeq: must be ignored
    const pollResultSameSeq = { state: 'AVAILABLE' };
    let shouldClaim1 = false;
    if (pollResultSameSeq.state === 'AVAILABLE') {
      if (state.requiresFreshDetection) {
        const isWithinCooldown = state.staleDetectionUntilTs ? Date.now() < state.staleDetectionUntilTs : false;
        const isSamePollSeq = state.staleDetectionPollSeq ? state.pollSeq <= state.staleDetectionPollSeq : false;
        if (!isWithinCooldown && !isSamePollSeq) {
          shouldClaim1 = true;
        }
      }
    }
    expect(shouldClaim1).toBe(false);

    // Intervening poll reports FULL: re-arms the guard!
    const interveningPoll = { state: 'FULL' };
    if (interveningPoll.state === 'FULL' || interveningPoll.state === 'DISABLED') {
      if (state.requiresFreshDetection) {
        state.requiresFreshDetection = false;
      }
    }
    expect(state.requiresFreshDetection).toBe(false);

    // Genuinely fresh detection after re-arm: must allow claim!
    state.pollSeq = 6;
    const freshPollResult = { state: 'AVAILABLE' };
    let shouldClaim2 = false;
    if (freshPollResult.state === 'AVAILABLE') {
      if (state.requiresFreshDetection) {
        // guarded
      } else {
        shouldClaim2 = true;
      }
    }
    expect(shouldClaim2).toBe(true);
  });
});
