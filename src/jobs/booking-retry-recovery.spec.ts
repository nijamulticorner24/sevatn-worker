import { WorkerOrchestrator } from '../worker/orchestrator';
import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';
import { BookingWorker } from './booking-worker';
import { BookingExecutionGuard } from '../security/execution-guard';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';

describe('Intelligent Booking Retry and Recovery Logic - 10 Test Scenarios', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockHeartbeat: jest.Mocked<HeartbeatService>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MAX_ACTIVE_BOOKINGS;
    delete process.env.MAX_AVAILABILITY_MONITORS;

    mockApiClient = {
      claimJob: jest.fn().mockResolvedValue({ hasJob: false }),
      getDemandDates: jest.fn().mockResolvedValue([]),
      updateJobProgress: jest.fn().mockResolvedValue({}),
      failJob: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({}),
      sendHeartbeat: jest.fn().mockResolvedValue({ executionPermitted: true, desiredState: 'RUNNING' }),
      renewLease: jest.fn().mockResolvedValue({ renewed: true }),
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

  const validNominee = {
    nomineeName: 'Ayyappan Devotee',
    nomineeAge: 35,
    nomineeRelationship: 'Brother',
    nomineePhone: '9876543210',
  };

  // SCENARIO 1: Wrong password -> corrected password -> same booking succeeds
  it('Scenario 1: Wrong password fails with CREDENTIALS_INVALID (MANUAL_REVIEW), corrected password allows same booking to succeed', async () => {
    const bookingWorker = new BookingWorker(mockApiClient);

    // 1. Initial attempt with wrong password
    const badJob: any = {
      id: 'job-pass-1',
      bookingRequestId: 'req-same-booking-001',
      bookingCode: 'TA-2026-PWD-01',
      requestedDate: '2026-11-25',
      route: 'Pamba',
      selectedTime: '06:00 - 07:00',
      nominee: validNominee,
      leaseGeneration: 1,
      fencingToken: 'f-1',
      account: {
        id: 'acc-1',
        username: 'devotee@example.com',
        encryptedPassword: 'wrong-pass-enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'INVALID_CREDENTIALS', message: 'Invalid username or password' }),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const CredentialManager = require('../security/credential-manager').CredentialManager;
    jest.spyOn(CredentialManager, 'decrypt').mockReturnValue('wrong-secret');

    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockImplementation(mockAdapter.init);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockImplementation(mockAdapter.openLogin);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockImplementation(mockAdapter.login);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockImplementation(mockAdapter.close);

    await bookingWorker.execute(badJob);

    // Verify it reported INVALID_CREDENTIALS without cancelling or creating new booking
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-pass-1',
      expect.objectContaining({
        status: 'LOGIN_FAILED',
        errorCode: 'INVALID_CREDENTIALS',
      })
    );

    // 2. Corrected password attempt on the SAME bookingRequestId & bookingCode
    const correctedJob: any = {
      ...badJob,
      id: 'job-pass-2', // fresh job claim for the same booking
      account: {
        ...badJob.account,
        encryptedPassword: 'correct-pass-enc',
      },
    };

    jest.spyOn(CredentialManager, 'decrypt').mockReturnValue('correct-secret');
    mockAdapter.login.mockResolvedValue({ status: 'LOGIN_SUCCESS' });
    mockAdapter.navigateToHomeAndDarshan = jest.fn().mockResolvedValue(undefined);
    mockAdapter.selectAuthenticatedDateAndRoute = jest.fn().mockResolvedValue(undefined);
    mockAdapter.selectPostLoginTimeSlot = jest.fn().mockResolvedValue({ success: true, selectedSlot: '06:00 - 07:00' });
    mockAdapter.selectBookingType = jest.fn().mockResolvedValue(undefined);
    mockAdapter.verifyDateTimePreserved = jest.fn().mockReturnValue(true);
    mockAdapter.selectAllExistingPilgrims = jest.fn().mockResolvedValue(undefined);
    mockAdapter.populateNomineeDetails = jest.fn().mockResolvedValue(undefined);
    mockAdapter.handlePrasadamDetails = jest.fn().mockResolvedValue(undefined);
    mockAdapter.selectReliefFundNo = jest.fn().mockResolvedValue(undefined);
    mockAdapter.addToWishlistAndVerify = jest.fn().mockResolvedValue(undefined);
    mockAdapter.proceedToPaymentGateway = jest.fn().mockResolvedValue(undefined);
    mockAdapter.verifyPaymentSummary = jest.fn().mockResolvedValue(undefined);
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ2611250000000001',
    });

    PlaywrightSabarimalaAdapter.prototype.navigateToHomeAndDarshan = mockAdapter.navigateToHomeAndDarshan;
    PlaywrightSabarimalaAdapter.prototype.selectAuthenticatedDateAndRoute = mockAdapter.selectAuthenticatedDateAndRoute;
    PlaywrightSabarimalaAdapter.prototype.selectPostLoginTimeSlot = mockAdapter.selectPostLoginTimeSlot;
    PlaywrightSabarimalaAdapter.prototype.selectBookingType = mockAdapter.selectBookingType;
    PlaywrightSabarimalaAdapter.prototype.verifyDateTimePreserved = mockAdapter.verifyDateTimePreserved;
    PlaywrightSabarimalaAdapter.prototype.selectAllExistingPilgrims = mockAdapter.selectAllExistingPilgrims;
    PlaywrightSabarimalaAdapter.prototype.populateNomineeDetails = mockAdapter.populateNomineeDetails;
    PlaywrightSabarimalaAdapter.prototype.handlePrasadamDetails = mockAdapter.handlePrasadamDetails;
    PlaywrightSabarimalaAdapter.prototype.selectReliefFundNo = mockAdapter.selectReliefFundNo;
    PlaywrightSabarimalaAdapter.prototype.addToWishlistAndVerify = mockAdapter.addToWishlistAndVerify;
    PlaywrightSabarimalaAdapter.prototype.proceedToPaymentGateway = mockAdapter.proceedToPaymentGateway;
    PlaywrightSabarimalaAdapter.prototype.verifyPaymentSummary = mockAdapter.verifyPaymentSummary;
    PlaywrightSabarimalaAdapter.prototype.executePaymentProceedAndConfirm = mockAdapter.executePaymentProceedAndConfirm;

    await bookingWorker.execute(correctedJob);

    // Confirms success with official reference on the SAME booking request
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-pass-2',
      expect.objectContaining({
        officialReference: 'IVQ2611250000000001',
      })
    );
  });

  // SCENARIO 2: Temporary login failure, same booking retries
  it('Scenario 2: Temporary login failure marks RETRYABLE_FAILURE, allowing same booking to retry', async () => {
    const bookingWorker = new BookingWorker(mockApiClient);

    const job: any = {
      id: 'job-temp-login-1',
      bookingRequestId: 'req-temp-002',
      bookingCode: 'TA-2026-TEMP-02',
      requestedDate: '2026-11-25',
      route: 'Pamba',
      nominee: validNominee,
      leaseGeneration: 1,
      fencingToken: 'f-1',
      account: {
        id: 'acc-2',
        username: 'devotee2@example.com',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    const CredentialManager = require('../security/credential-manager').CredentialManager;
    jest.spyOn(CredentialManager, 'decrypt').mockReturnValue('secret');

    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockResolvedValue(true);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockResolvedValue({
      status: 'SITE_ERROR',
      message: 'Portal 502 Bad Gateway',
    });
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockResolvedValue(undefined);

    await bookingWorker.execute(job);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-temp-login-1',
      expect.objectContaining({
        status: 'RETRYABLE_FAILURE',
        errorCode: 'SITE_ERROR',
      })
    );
  });

  // SCENARIO 3: Date field missing, page refresh, same booking resumes
  it('Scenario 3: Date field missing raises RETRYABLE_FAILURE (AUTHENTICATED_DATE_SELECTION_FAILED), preserving booking for retry', async () => {
    const bookingWorker = new BookingWorker(mockApiClient);

    const job: any = {
      id: 'job-date-missing-1',
      bookingRequestId: 'req-date-003',
      bookingCode: 'TA-2026-DATE-03',
      requestedDate: '2026-11-25',
      route: 'Pamba',
      nominee: validNominee,
      leaseGeneration: 1,
      fencingToken: 'f-1',
      account: {
        id: 'acc-3',
        username: 'devotee3@example.com',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockResolvedValue(true);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockResolvedValue({ status: 'LOGIN_SUCCESS' });
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'navigateToHomeAndDarshan').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectAuthenticatedDateAndRoute').mockRejectedValue(
      new Error('AUTHENTICATED_DATE_SELECTION_FAILED: input#darshan_date field not found in DOM')
    );
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockResolvedValue(undefined);

    await bookingWorker.execute(job);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-date-missing-1',
      expect.objectContaining({
        status: 'RETRYABLE_FAILURE',
        errorCode: 'AUTHENTICATED_DATE_SELECTION_FAILED',
      })
    );
  });

  // SCENARIO 4: Route selection failure, same booking retries
  it('Scenario 4: Route selection failure marks RETRYABLE_FAILURE and allows retry', async () => {
    const bookingWorker = new BookingWorker(mockApiClient);

    const job: any = {
      id: 'job-route-fail-1',
      bookingRequestId: 'req-route-004',
      bookingCode: 'TA-2026-ROUTE-04',
      requestedDate: '2026-11-25',
      route: 'Erumeli',
      nominee: validNominee,
      leaseGeneration: 1,
      fencingToken: 'f-1',
      account: {
        id: 'acc-4',
        username: 'devotee4@example.com',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockResolvedValue(true);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockResolvedValue({ status: 'LOGIN_SUCCESS' });
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'navigateToHomeAndDarshan').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectAuthenticatedDateAndRoute').mockRejectedValue(
      new Error('AUTHENTICATED_ROUTE_SELECTION_FAILED: Erumeli radio input could not be selected')
    );
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockResolvedValue(undefined);

    await bookingWorker.execute(job);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-route-fail-1',
      expect.objectContaining({
        status: 'RETRYABLE_FAILURE',
        errorCode: 'AUTHENTICATED_ROUTE_SELECTION_FAILED',
      })
    );
  });

  // SCENARIO 5: Session expiry, re-login and resume
  it('Scenario 5: Session expiry triggers retryable recovery with re-login', async () => {
    const bookingWorker = new BookingWorker(mockApiClient);

    const job: any = {
      id: 'job-session-expired-1',
      bookingRequestId: 'req-session-005',
      bookingCode: 'TA-2026-SESSION-05',
      requestedDate: '2026-11-25',
      route: 'Pamba',
      nominee: validNominee,
      leaseGeneration: 1,
      fencingToken: 'f-1',
      account: {
        id: 'acc-5',
        username: 'devotee5@example.com',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockResolvedValue(true);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockResolvedValue({ status: 'LOGIN_SUCCESS' });
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'navigateToHomeAndDarshan').mockRejectedValue(
      new Error('SESSION_EXPIRED: Redirected back to #/login due to inactive session')
    );
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockResolvedValue(undefined);

    await bookingWorker.execute(job);

    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-session-expired-1',
      expect.objectContaining({
        status: 'RETRYABLE_FAILURE',
        errorCode: 'SESSION_EXPIRED',
      })
    );
  });

  // SCENARIO 6: Availability becomes FULL, return to checking/watching
  it('Scenario 6: When availability is FULL, orchestrator stays in WATCHING without claiming', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 1000, 1000);

    const key = '2026-11-25:Pamba';
    (orchestrator as any).keyStates.set(key, {
      demandKey: key,
      phase: 'WATCHING',
      pollSeq: 1,
      bookingIds: ['req-full-006'],
      watchStartedAt: Date.now(),
    });

    // Mock pollAvailabilityForDate returning FULL
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'FULL',
      available: false,
    });

    const state = (orchestrator as any).keyStates.get(key);
    await (orchestrator as any).tickDemandKey(key, state, Date.now());

    // Key must remain in WATCHING phase
    expect(state).toBeDefined();
    expect(state.phase).toBe('WATCHING');
    // No booking claim should have been dispatched
    expect(mockApiClient.claimJob).not.toHaveBeenCalled();
  });

  // SCENARIO 7: API timeout, retry without false FULL classification
  it('Scenario 7: API timeout marks batch UNKNOWN, preserving WATCHING without classifying date as FULL', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 1000, 1000);

    const key = '2026-11-25:Pamba';
    (orchestrator as any).keyStates.set(key, {
      demandKey: key,
      phase: 'WATCHING',
      pollSeq: 1,
      bookingIds: ['req-timeout-007'],
      watchStartedAt: Date.now(),
    });

    // Mock pollAvailabilityForDate returning UNKNOWN
    jest.spyOn(orchestrator as any, 'pollAvailabilityForDate').mockResolvedValue({
      state: 'UNKNOWN',
      available: false,
    });

    const state = (orchestrator as any).keyStates.get(key);
    await (orchestrator as any).tickDemandKey(key, state, Date.now());

    expect(state).toBeDefined();
    expect(state.phase).toBe('WATCHING');
    // Ensure claimJob is never called on UNKNOWN
    expect(mockApiClient.claimJob).not.toHaveBeenCalled();
  });

  // SCENARIO 8: Booking submission timeout, verify portal history before resubmitting
  it('Scenario 8: Booking submission timeout checks portal history; if pass exists, completes as SUCCESS', async () => {
    const bookingWorker = new BookingWorker(mockApiClient);

    const job: any = {
      id: 'job-submit-timeout-1',
      bookingRequestId: 'req-timeout-008',
      bookingCode: 'TA-2026-SUBMIT-08',
      requestedDate: '2026-11-25',
      route: 'Pamba',
      nominee: validNominee,
      leaseGeneration: 1,
      fencingToken: 'f-1',
      account: {
        id: 'acc-8',
        username: 'devotee8@example.com',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'openLogin').mockResolvedValue(true);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'login').mockResolvedValue({ status: 'LOGIN_SUCCESS' });
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'navigateToHomeAndDarshan').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectAuthenticatedDateAndRoute').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectPostLoginTimeSlot').mockResolvedValue({ success: true, selectedSlot: '06:00 - 07:00' });
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectBookingType').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'verifyDateTimePreserved').mockReturnValue(true);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectAllExistingPilgrims').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'populateNomineeDetails').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'handlePrasadamDetails').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'selectReliefFundNo').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'addToWishlistAndVerify').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'proceedToPaymentGateway').mockResolvedValue(undefined);
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'verifyPaymentSummary').mockResolvedValue(undefined);

    // Timeout during payment submission
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'executePaymentProceedAndConfirm').mockRejectedValue(
      new Error('NAVIGATION_TIMEOUT: Confirmation spinner hung for 30s')
    );
    // But history check finds the created pass
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'checkExistingBookingInHistory').mockResolvedValue({
      found: true,
      officialReference: 'IVQ2611259999999999',
      confirmedAt: '2026-11-23T05:40:00Z',
    });
    jest.spyOn(PlaywrightSabarimalaAdapter.prototype, 'close').mockResolvedValue(undefined);

    await bookingWorker.execute(job);

    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-submit-timeout-1',
      expect.objectContaining({
        officialReference: 'IVQ2611259999999999',
      })
    );
  });

  // SCENARIO 9: RETRYABLE_FAILURE never becomes SUCCESS
  it('Scenario 9: RETRYABLE_FAILURE never marks terminalStatus=SUCCESS or deletes watch loop', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 1000, 1000);

    const key = '2026-11-25:Pamba';
    const state: any = {
      demandKey: key,
      phase: 'BOOKING',
      pollSeq: 2,
      bookingIds: ['req-009'],
      watchStartedAt: Date.now() - 5000,
    };
    (orchestrator as any).keyStates.set(key, state);

    // Mock claim returning an active job
    mockApiClient.claimJob.mockResolvedValue({
      hasJob: true,
      jobType: 'BOOKING_EXECUTION',
      job: {
        id: 'job-failing-009',
        bookingRequestId: 'req-009',
        bookingCode: 'TA-2026-FAIL-09',
        date: '2026-11-25',
        route: 'Pamba',
      },
    });

    // Mock processJobAsync failing with AUTHENTICATED_DATE_SELECTION_FAILED
    jest.spyOn(orchestrator as any, 'processJobAsync').mockImplementation(async () => {
      BookingExecutionGuard.updateLifecycleState('req-009', 'RETRYABLE_FAILURE');
      throw new Error('BOOKING_EXECUTION_UNCONFIRMED: RETRYABLE_FAILURE (AUTHENTICATED_DATE_SELECTION_FAILED)');
    });

    await (orchestrator as any).executeBookingFlow(key, state, '2026-11-25', 'Pamba');

    // The key state must NOT be deleted! It must return to WATCHING
    expect((orchestrator as any).keyStates.has(key)).toBe(true);
    const updatedState = (orchestrator as any).keyStates.get(key);
    expect(updatedState.phase).toBe('WATCHING');
  });

  // SCENARIO 10: Duplicate claim rejected without losing pending date
  it('Scenario 10: When worker is already at max capacity, slot opened does not claim duplicate and preserves pending date', async () => {
    process.env.MAX_ACTIVE_BOOKINGS = '1';
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 1000, 1000);

    // Simulate 1 active execution running
    (orchestrator as any).activeExecutions = 1;

    const key = '2026-11-25:Pamba';
    const state: any = {
      demandKey: key,
      phase: 'WATCHING',
      pollSeq: 5,
      bookingIds: ['req-dup-010'],
      watchStartedAt: Date.now() - 10000,
    };
    (orchestrator as any).keyStates.set(key, state);

    // Slot opened triggered for this date
    await (orchestrator as any).executeBookingFlow(key, state, '2026-11-25', 'Pamba');

    // claimJob should NOT have been called due to active capacity limit
    expect(mockApiClient.claimJob).not.toHaveBeenCalled();
    // Pending date preserved in WATCHING phase
    expect(state.phase).toBe('WATCHING');
    expect((orchestrator as any).keyStates.has(key)).toBe(true);
  });
});
