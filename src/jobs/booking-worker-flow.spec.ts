import { BookingWorker, BookingJobData } from './booking-worker';
import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { BookingExecutionGuard } from '../security/execution-guard';
import { AvailabilityCache } from '../availability/availability-cache';
import { ConfirmMarkerManager } from '../security/confirm-marker';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

describe('TicketAssist Booking Worker Sequence & Flow Regression Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockAdapter: any;

  const mockEncryptedAccount = {
    id: 'acc-123',
    username: '9876543210',
    encryptedPassword: 'enc:sample',
    encryptionIv: 'iv:sample',
    encryptionTag: 'tag:sample',
  };

  const sampleJob: BookingJobData = {
    id: 'job-001',
    bookingRequestId: 'req-001',
    bookingCode: 'TA-2026-999',
    requestedDate: '2026-10-20',
    route: 'Pamba - Marakkoottam - 4 Kms',
    timeSlot: 'Any Slot',
    account: mockEncryptedAccount,
    pilgrims: [{ fullName: 'Devotee A', age: 30, gender: 'MALE', idType: 'AADHAAR', idNumber: '111122223333' }],
    nominee: {
      nomineeName: 'Arthi',
      nomineeAge: 25,
      nomineeRelationship: 'Spouse',
      nomineePhone: '9876543210',
    },
    verifiedAvailable: true,
    leaseGeneration: 1,
    fencingToken: 'fnc_flow_test_123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    BookingExecutionGuard.clearAll();
    AvailabilityCache.getInstance().clear();

    mockApiClient = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      failJob: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({}),
      authorizePayment: jest.fn().mockResolvedValue({ authorized: true }),
    } as any;

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('DecryptedPassword123');

    mockAdapter = {
      init: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      navigateToHomeAndDarshan: jest.fn().mockResolvedValue(true),
      selectAuthenticatedDateAndRoute: jest.fn().mockResolvedValue(true),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      ensureBookingPageReady: jest.fn().mockResolvedValue(true),
      selectPostLoginTimeSlot: jest.fn().mockResolvedValue({
        success: true,
        selectedSlot: '05:00 - 06:00',
      }),
      selectBookingType: jest.fn().mockResolvedValue({
        success: true,
        selectedType: 'Others',
      }),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectAllExistingPilgrims: jest.fn().mockResolvedValue({ success: true, count: 1 }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      checkWishlistForItem: jest.fn().mockResolvedValue(false),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: 'IVQ26100514030705319660',
      }),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true, state: 'AVAILABLE' }),
      selectRequestedDate: jest.fn().mockResolvedValue({ success: true, selectedDate: '2026-10-20' }),
      selectRoute: jest.fn().mockResolvedValue({ success: true, selectedRoute: 'Pamba - Marakkoottam - 4 Kms' }),
      proceedToLogin: jest.fn().mockResolvedValue({ success: true }),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      logout: jest.fn().mockResolvedValue(true),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);
  });

  it('1. Live portal flow: executes complete official flow starting with darshanAvailability through to confirmation', async () => {
    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    // Step 1: Open darshan availability & check requested date
    expect(mockAdapter.openDarshanAvailability).toHaveBeenCalled();
    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledWith('2026-10-20');
    expect(mockAdapter.selectRoute).toHaveBeenCalledWith('Pamba - Marakkoottam - 4 Kms');
    expect(mockAdapter.checkRequestedDateAvailability).not.toHaveBeenCalled();

    // Step 2: Proceed to login via portal button and authenticate
    expect(mockAdapter.proceedToLogin).toHaveBeenCalled();
    expect(CredentialManager.decrypt).toHaveBeenCalledWith('enc:sample', 'iv:sample', 'tag:sample');
    expect(mockAdapter.login).toHaveBeenCalledWith('9876543210', 'DecryptedPassword123');

    // Step 3: Verify carried date and route
    expect(mockAdapter.verifyCarriedDateAndRoute).toHaveBeenCalled();

    // Step 4: Slot and booking details
    expect(mockAdapter.selectPostLoginTimeSlot).toHaveBeenCalled();
    expect(mockAdapter.selectBookingType).toHaveBeenCalled();
    expect(mockAdapter.selectAllExistingPilgrims).toHaveBeenCalled();
    expect(mockAdapter.populateNomineeDetails).toHaveBeenCalled();
    expect(mockAdapter.handlePrasadamDetails).toHaveBeenCalled();
    expect(mockAdapter.selectReliefFundNo).toHaveBeenCalled();

    // Step 5: Wishlist and confirmation
    expect(mockAdapter.addToWishlistAndVerify).toHaveBeenCalled();
    expect(mockAdapter.proceedToPaymentGateway).toHaveBeenCalled();
    expect(mockAdapter.verifyPaymentSummary).toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).toHaveBeenCalled();
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      officialReference: 'IVQ26100514030705319660',
    }));

    // Must update progress through finite states
    expect(mockApiClient.updateJobProgress).toHaveBeenCalledWith('job-001', expect.objectContaining({ status: 'PROCESSING' }));
    expect(mockApiClient.updateJobProgress).toHaveBeenCalledWith('job-001', expect.objectContaining({ status: 'LOGIN_SUCCESS' }));
    expect(mockApiClient.updateJobProgress).toHaveBeenCalledWith('job-001', expect.objectContaining({ status: 'WISHLIST_VERIFIED' }));
    expect(mockApiClient.updateJobProgress).toHaveBeenCalledWith('job-001', expect.objectContaining({ status: 'PROCEEDING_TO_CHECKOUT' }));
    expect(mockApiClient.updateJobProgress).toHaveBeenCalledWith('job-001', expect.objectContaining({ status: 'CHECKOUT_VERIFIED' }));
    expect(mockApiClient.updateJobProgress).toHaveBeenCalledWith('job-001', expect.objectContaining({ status: 'ZERO_COST_CONFIRMATION_PENDING' }));
  });

  it('2. Login failure (invalid credentials): reports terminal LOGIN_FAILED without retry loop', async () => {
    mockAdapter.login.mockResolvedValue({
      status: 'INVALID_CREDENTIALS',
      message: 'Incorrect password entered',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.login).toHaveBeenCalledWith('9876543210', 'DecryptedPassword123');
    expect(mockAdapter.navigateToHomeAndDarshan).not.toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'LOGIN_FAILED',
      errorCode: 'INVALID_CREDENTIALS',
    }));
  });

  it('3. Login verification challenge (OTP/CAPTCHA): safely reports TEMPORARY_SLOT_LOST returning to WATCHING', async () => {
    mockAdapter.login.mockResolvedValue({
      status: 'OTP_REQUIRED',
      message: 'Official portal requested OTP verification',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.login).toHaveBeenCalledWith('9876543210', 'DecryptedPassword123');
    expect(mockAdapter.navigateToHomeAndDarshan).not.toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'OTP_REQUIRED',
    }));
  });

  it('4. Site Error: safely handles portal unreachable during darshanAvailability navigation', async () => {
    mockAdapter.openDarshanAvailability.mockResolvedValue({ success: false });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.openDarshanAvailability).toHaveBeenCalled();
    expect(mockAdapter.login).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'SITE_ERROR',
      errorCode: 'OFFICIAL_SITE_UNAVAILABLE',
    }));
  });

  it('5. Missing Credentials: safely fails with CREDENTIALS_MISSING without leakage', async () => {
    const jobWithoutAccount: BookingJobData = {
      ...sampleJob,
      account: null,
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(jobWithoutAccount);

    expect(mockAdapter.proceedToLogin).toHaveBeenCalled();
    expect(CredentialManager.decrypt).not.toHaveBeenCalled();
    expect(mockAdapter.login).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'LOGIN_FAILED',
      errorCode: 'CREDENTIALS_MISSING',
    }));
  });

  it('6. Booking-to-Account Association: uses correct decrypted credentials for specific booking', async () => {
    const anotherJob: BookingJobData = {
      ...sampleJob,
      id: 'job-999',
      bookingCode: 'TA-2026-888',
      account: {
        id: 'acc-999',
        username: '9123456789',
        encryptedPassword: 'enc:custom',
        encryptionIv: 'iv:custom',
        encryptionTag: 'tag:custom',
      },
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('DecryptedCustomPass');

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(anotherJob);

    expect(CredentialManager.decrypt).toHaveBeenCalledWith('enc:custom', 'iv:custom', 'tag:custom');
    expect(mockAdapter.login).toHaveBeenCalledWith('9123456789', 'DecryptedCustomPass');
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-999', expect.any(Object));
  });

  it('7. Missing Nominee Details: safely stops with TEMPORARY_SLOT_LOST and defers devotee', async () => {
    mockAdapter.populateNomineeDetails.mockRejectedValue(
      new Error('NOMINEE_DETAILS_MISSING: Nominee details are mandatory for pilgrim #1 but not provided in booking data.')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.populateNomineeDetails).toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'NOMINEE_DETAILS_MISSING',
    }));
  });

  it('8. Official Portal Restriction: catches previous booking restriction and defers devotee to WATCHING', async () => {
    mockAdapter.addToWishlistAndVerify.mockRejectedValue(
      new Error('PREVIOUS_BOOKING_RESTRICTION: Official portal reports you cannot make transaction until you avail previous booking.')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.addToWishlistAndVerify).toHaveBeenCalled();
    expect(mockAdapter.proceedToPaymentGateway).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'WISHLIST_DEFERRED',
    }));
  });

  it('9. Post-login Slot Unavailable: catches slot depletion and marks TEMPORARY_SLOT_LOST', async () => {
    mockAdapter.selectPostLoginTimeSlot.mockRejectedValue(
      new Error('SLOT_UNAVAILABLE: All post-login slots are fully booked or closed on 2026-10-20')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.selectPostLoginTimeSlot).toHaveBeenCalled();
    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'SLOT_UNAVAILABLE',
    }));
  });

  it('10. Unverified Slot: fails safely with TEMPORARY_SLOT_LOST and does not silently proceed', async () => {
    mockAdapter.selectPostLoginTimeSlot.mockRejectedValue(
      new Error('SLOT_SELECTION_UNVERIFIED: Clicked slot card 05:00 - 06:00 but official portal did not accept the selection (.slot-dar-5 missing).')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.selectPostLoginTimeSlot).toHaveBeenCalled();
    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'SLOT_SELECTION_UNVERIFIED',
    }));
  });

  it('11. Disabled Add to Wishlist Button (#regi_continue): defers devotee and returns to WATCHING', async () => {
    mockAdapter.addToWishlistAndVerify.mockRejectedValue(
      new Error('BUTTON_DISABLED: Add to Wishlist button (#regi_continue) is disabled. Reason: Slot selection unconfirmed on portal.')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.addToWishlistAndVerify).toHaveBeenCalled();
    expect(mockAdapter.proceedToPaymentGateway).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'WISHLIST_DEFERRED',
    }));
  });

  it('12. Relief Fund Verification Failure: safely reports TEMPORARY_SLOT_LOST and returns to WATCHING', async () => {
    mockAdapter.selectReliefFundNo.mockRejectedValue(
      new Error('RELIEF_FUND_UNVERIFIED: Relief fund "No" radio could not be verified as checked.')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.selectReliefFundNo).toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'RELIEF_FUND_ERROR',
    }));
  });

  it('13. Unexpected Non-Zero Payment Requirement: safely reports TEMPORARY_SLOT_LOST and returns to WATCHING', async () => {
    mockAdapter.verifyPaymentSummary.mockRejectedValue(
      new Error('PAYMENT_REQUIRED_OR_AMBIGUOUS: Payment gateway requires payment of ₹250. Automated payment not configured; requires human review.')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.verifyPaymentSummary).toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'ATTEMPT_UNSUCCESSFUL',
    }));
  });

  it('14. Ambiguous confirmation result: routes to UNKNOWN_RESULT rather than completing without reference', async () => {
    mockAdapter.executePaymentProceedAndConfirm.mockResolvedValue({
      confirmed: false,
      message: 'Official confirmation detected but authoritative reference was missing. Requires human reconciliation.',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.executePaymentProceedAndConfirm).toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: expect.stringMatching(/RECONCILIATION_REQUIRED|UNKNOWN_RESULT/),
      errorCode: expect.stringMatching(/VERIFICATION_PENDING|CONFIRMATION_UNVERIFIED/),
    }));
  });

  it('15. Duplicate Execution Guard: rejects concurrent second dispatch for the same active booking', async () => {
    // Acquire lock for sampleJob to simulate an ongoing execution
    const lockAcquired = BookingExecutionGuard.acquire({
      bookingId: 'req-001',
      bookingCode: 'TA-2026-999',
      jobId: 'job-001',
      dispatchSource: 'PENDING_MONITOR',
      owner: 'FIRST_WORKER_THREAD',
    });
    expect(lockAcquired.acquired).toBe(true);

    const worker = new BookingWorker(mockApiClient);
    // Attempt second execution for the same booking
    await worker.execute({
      ...sampleJob,
      id: 'job-duplicate',
    });

    // Must NOT start second adapter or proceed with login
    expect(mockAdapter.init).not.toHaveBeenCalled();
    expect(mockAdapter.openLogin).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  it('16. Missing Slot Cards: stops workflow before pilgrim submission and marks TEMPORARY_SLOT_LOST', async () => {
    mockAdapter.selectPostLoginTimeSlot.mockRejectedValue(
      new Error('SLOT_CARDS_MISSING: No slot cards appeared on authenticated booking page for date 2026-10-20. Stopping before pilgrim submission.')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    expect(mockAdapter.selectPostLoginTimeSlot).toHaveBeenCalled();
    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'SLOT_CARDS_MISSING',
    }));
  });

  it('17. Executes wishlist addition and verification without assuming pre-existing items match', async () => {
    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    // Must call addToWishlistAndVerify to ensure exact match of the target submission
    expect(mockAdapter.addToWishlistAndVerify).toHaveBeenCalled();
    // Must proceed directly to payment gateway
    expect(mockAdapter.proceedToPaymentGateway).toHaveBeenCalled();
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-001', expect.any(Object));
  });

  it('18. Live portal execution: opens darshanAvailability, selects date & route, then proceeds to login', async () => {
    const job: BookingJobData = {
      ...sampleJob,
      id: 'job-direct',
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(job);

    expect(mockAdapter.openDarshanAvailability).toHaveBeenCalled();
    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledWith('2026-10-20');
    expect(mockAdapter.selectRoute).toHaveBeenCalledWith('Pamba - Marakkoottam - 4 Kms');
    expect(mockAdapter.proceedToLogin).toHaveBeenCalled();
    expect(mockAdapter.login).toHaveBeenCalled();
  });

  // PR #0.1 Tests
  it('19. leaseGeneration = undefined on job throws LEASE_INCOMPLETE and updateJobProgress is never called', async () => {
    const jobWithoutLease: BookingJobData = {
      ...sampleJob,
      leaseGeneration: undefined,
      fencingToken: undefined,
    };

    const worker = new BookingWorker(mockApiClient);
    await expect(worker.execute(jobWithoutLease)).rejects.toThrow('LEASE_INCOMPLETE');

    // updateJobProgress must never be called
    expect(mockApiClient.updateJobProgress).not.toHaveBeenCalled();
    // Login flow must never run
    expect(mockAdapter.openLogin).not.toHaveBeenCalled();
    expect(mockAdapter.login).not.toHaveBeenCalled();
  });

  it('20. 403 from updateJobProgress during any phase calls reportFail(WORKER_ERROR) and login flow never runs', async () => {
    const error403: any = new Error('AxiosError 403: Forbidden');
    error403.response = { status: 403, data: { message: 'LEASE_GENERATION_REQUIRED' } };
    mockApiClient.updateJobProgress.mockRejectedValueOnce(error403);

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(sampleJob);

    // Login flow must never run
    expect(mockAdapter.openLogin).not.toHaveBeenCalled();
    expect(mockAdapter.login).not.toHaveBeenCalled();

    // Must report failure as WORKER_ERROR
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      sampleJob.id,
      expect.objectContaining({
        status: 'WORKER_ERROR',
      }),
    );
    expect(BookingExecutionGuard.isBookingActive(sampleJob.bookingRequestId!)).toBe(false);
  });

  it('21. Live portal execution: verifies requested date and route availability before proceedToLogin', async () => {
    const job: BookingJobData = {
      ...sampleJob,
      id: 'job-no-preflight',
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(job);

    expect(mockAdapter.openDarshanAvailability).toHaveBeenCalled();
    expect(mockAdapter.checkRequestedDateAvailability).not.toHaveBeenCalled();
    expect(mockAdapter.proceedToLogin).toHaveBeenCalled();
  });

  it('22. Direct execution: completes job with leaseGeneration and fencingToken', async () => {
    const job: BookingJobData = {
      ...sampleJob,
      id: 'job-fencing-verify',
      leaseGeneration: 5,
      fencingToken: 'fnc_token_999',
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(job);

    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-fencing-verify',
      expect.objectContaining({
        leaseGeneration: 5,
        fencingToken: 'fnc_token_999',
      }),
    );
  });

  it('23. Live portal execution: completes whole sequence through verification and completion', async () => {
    const job: BookingJobData = {
      ...sampleJob,
      id: 'job-direct-complete',
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(job);

    expect(mockAdapter.checkRequestedDateAvailability).not.toHaveBeenCalled();
    expect(mockAdapter.proceedToLogin).toHaveBeenCalled();
    expect(mockApiClient.completeJob).toHaveBeenCalled();
  });

  it('24. confirm without authorize: proceeds straight to confirmation without calling authorizePayment', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ26112015000012345',
      officialBookingReference: 'IVQ26112015000012345',
    });

    const jobWithLease: BookingJobData = {
      ...sampleJob,
      id: 'job-confirm-direct-test',
      leaseGeneration: 2,
      fencingToken: 'fnc_lease_token_direct',
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(jobWithLease);

    // Invariant: authorizePayment gate is removed and never invoked
    expect(mockApiClient.authorizePayment).not.toHaveBeenCalled();

    // Invariant: executePaymentProceedAndConfirm is called directly
    expect(mockAdapter.executePaymentProceedAndConfirm).toHaveBeenCalled();

    // Invariant: completeJob is called with scraped pass reference
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-confirm-direct-test',
      expect.objectContaining({
        officialBookingReference: 'IVQ26112015000012345',
        officialReference: 'IVQ26112015000012345',
      }),
    );
  });

  it('25. lease-expired completion: if completeJob rejects due to lease expiration, real pass is never failed or discarded', async () => {
    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ26112099999999999',
      officialBookingReference: 'IVQ26112099999999999',
    });

    mockApiClient.completeJob.mockRejectedValueOnce({
      response: { status: 409, data: { message: 'Stale lease generation' } },
      message: 'Conflict',
    });

    const jobWithLease: BookingJobData = {
      ...sampleJob,
      id: 'job-lease-expired-complete-test',
      leaseGeneration: 1,
      fencingToken: 'fnc_stale_token',
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(jobWithLease);

    // Invariant: failJob is NEVER called when a real pass was confirmed on portal
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
    // Guard is released properly
    expect(BookingExecutionGuard.isBookingActive(jobWithLease.bookingRequestId!)).toBe(false);
  });

  it('26. CONFIRM_CLICKED retry reconciliation: checks portal booking history and completes without re-booking', async () => {
    const reconCode = 'TA-2026-RECON-01';
    ConfirmMarkerManager.setMarker(reconCode, {
      bookingCode: reconCode,
      jobId: 'job-recon-1',
    });

    mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
      found: true,
      officialReference: 'IVQ26112088888888888',
      confirmedAt: '2026-11-20T10:00:00.000Z',
    });

    const reconJob: BookingJobData = {
      ...sampleJob,
      id: 'job-recon-1',
      bookingCode: reconCode,
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(reconJob);

    // Verified: history was checked
    expect(mockAdapter.checkExistingBookingInHistory).toHaveBeenCalled();

    // Invariant: Flow did NOT proceed to re-booking (did not select date & route)
    expect(mockAdapter.selectAuthenticatedDateAndRoute).not.toHaveBeenCalled();

    // Invariant: Completed directly using the existing reference
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-recon-1',
      expect.objectContaining({
        officialBookingReference: 'IVQ26112088888888888',
        officialReference: 'IVQ26112088888888888',
      }),
    );

    // Invariant: marker file cleared
    expect(ConfirmMarkerManager.hasMarker(reconCode)).toBe(false);
  });
});
