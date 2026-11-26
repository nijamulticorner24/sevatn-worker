import { BookingWorker, BookingJobData } from './booking-worker';
import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { BookingExecutionGuard } from '../security/execution-guard';
import { WorkerOrchestrator } from '../worker/orchestrator';
import { HeartbeatService } from '../heartbeat/heartbeat';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

describe('Sequential Devotee Booking Through Availability Watch Queue Test Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockAdapter: any;

  const sampleAccount = {
    id: 'acc-multi-01',
    username: '9876543210',
    encryptedPassword: 'enc:multi',
    encryptionIv: 'iv:multi',
    encryptionTag: 'tag:multi',
  };

  const twoDevoteeJob: BookingJobData = {
    id: 'job-multi-001',
    bookingRequestId: 'req-multi-001',
    bookingCode: 'TA-MULTI-2026',
    requestedDate: '2026-11-20',
    route: 'Pamba - Marakkoottam - 4 Kms',
    timeSlot: 'Any Slot',
    account: sampleAccount,
    pilgrimCount: 2,
    pilgrims: [
      {
        id: 'pilgrim-task-1',
        fullName: 'Devotee One',
        age: 35,
        gender: 'MALE',
        idType: 'AADHAAR',
        idNumber: '998877665544',
        nomineeName: 'Nominee One',
        nomineeAge: 30,
        nomineeRelationship: 'Spouse',
        nomineePhone: '9876543210',
        metadata: { taskStatus: 'PENDING' },
      },
      {
        id: 'pilgrim-task-2',
        fullName: 'Devotee Two',
        age: 28,
        gender: 'MALE',
        idType: 'AADHAAR',
        idNumber: '112233445566',
        nomineeName: 'Nominee Two',
        nomineeAge: 55,
        nomineeRelationship: 'Mother',
        nomineePhone: '9876543211',
        metadata: { taskStatus: 'PENDING' },
      },
    ],
    leaseGeneration: 1,
    fencingToken: 'fnc_multi_token_001',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    BookingExecutionGuard.clearAll();

    mockApiClient = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      failJob: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      authorizePayment: jest.fn().mockResolvedValue({ authorized: true }),
    } as any;

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');

    mockAdapter = {
      init: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true, url: 'https://sabarimalaonline.org/#/darshanAvailability' }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true, state: 'AVAILABLE' }),
      selectRequestedDate: jest.fn().mockResolvedValue({ success: true, selectedDate: '2026-11-20' }),
      selectRoute: jest.fn().mockResolvedValue({ success: true, selectedRoute: 'Pamba - Marakkoottam - 4 Kms' }),
      discoverAvailableSlots: jest.fn().mockResolvedValue([{ slotName: '05:00 - 06:00', availabilityCount: 150 }]),
      proceedToLogin: jest.fn().mockResolvedValue({ success: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      logout: jest.fn().mockResolvedValue(true),
      navigateToHomeAndDarshan: jest.fn().mockResolvedValue(true),
      selectAuthenticatedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '05:00 - 06:00', refreshAttempts: 0 }),
      reloadBookingPage: jest.fn().mockResolvedValue(undefined),
      selectBookingType: jest.fn().mockResolvedValue({ success: true, selectedType: 'Others' }),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockResolvedValue({
        success: true,
        selectedPilgrim: {
          fullName: 'Devotee One',
          identityFingerprint: 'fp_devotee_one_123',
          age: 35,
          gender: 'MALE',
        },
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: 'IVQ2611200000000000001',
      }),
      checkExistingBookingInHistory: jest.fn().mockResolvedValue({ found: false }),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);
  });

  it('Step 1 & 2: Books Devotee 1 ONLY in the first availability cycle and does not process Devotee 2 immediately', async () => {
    const worker = new BookingWorker(mockApiClient);
    await worker.execute(twoDevoteeJob);

    // Verified: completeJob called with Devotee 1 details
    expect(mockApiClient.completeJob).toHaveBeenCalledTimes(1);
    const completePayload: any = mockApiClient.completeJob.mock.calls[0][1];
    expect(completePayload.officialReference).toBe('IVQ2611200000000000001');
    expect(completePayload.pilgrimTaskId).toBe('pilgrim-task-1');
    expect(completePayload.taskIndex).toBe(1);
    expect(completePayload.isFinalPilgrim).toBe(false);
    expect(completePayload.remainingDevoteesCount).toBe(1);

    // Verified: Step 3 Notification logged in note
    expect(completePayload.note).toBe(
      'Devotee 1 of 2 completed successfully. Booking reference: IVQ2611200000000000001. Remaining devotees: 1. Returning to availability monitoring.',
    );

    // Verified: Step 4 Logout called to safely exit booking flow
    expect(mockAdapter.logout).toHaveBeenCalled();

    // Verified: Lifecycle state is PARTIALLY_COMPLETED, NOT BOOKING_CONFIRMED
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-multi-001');
    expect(lifecycle).toBe('PARTIALLY_COMPLETED');

    // Devotee 2 was NOT processed in this cycle
    expect(mockAdapter.executePaymentProceedAndConfirm).toHaveBeenCalledTimes(1);
  });

  it('Step 1, 2 & 3: Next availability cycle claims Devotee 2, excludes Devotee 1, and marks BOOKING_CONFIRMED when done', async () => {
    // Devotee 1 is now CONFIRMED in the database
    const jobDevoteeTwoPending: BookingJobData = {
      ...twoDevoteeJob,
      pilgrims: [
        {
          ...twoDevoteeJob.pilgrims![0],
          metadata: {
            taskStatus: 'CONFIRMED',
            officialBookingReference: 'IVQ2611200000000000001',
            selectedPilgrim: { identityFingerprint: 'fp_devotee_one_123' },
          },
        },
        twoDevoteeJob.pilgrims![1],
      ],
    };

    mockAdapter.selectSingleSavedPilgrim = jest.fn().mockImplementation(async (ctx: any) => {
      // Must exclude Devotee 1 fingerprint
      expect(ctx.excludedPilgrimFingerprints).toContain('fp_devotee_one_123');
      return {
        success: true,
        selectedPilgrim: {
          fullName: 'Devotee Two',
          identityFingerprint: 'fp_devotee_two_456',
          age: 28,
          gender: 'MALE',
        },
      };
    });

    mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
      confirmed: true,
      officialReference: 'IVQ2611200000000000002',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(jobDevoteeTwoPending);

    // CompleteJob called for Devotee 2
    expect(mockApiClient.completeJob).toHaveBeenCalledTimes(1);
    const completePayload: any = mockApiClient.completeJob.mock.calls[0][1];
    expect(completePayload.officialReference).toBe('IVQ2611200000000000002');
    expect(completePayload.pilgrimTaskId).toBe('pilgrim-task-2');
    expect(completePayload.taskIndex).toBe(2);
    expect(completePayload.isFinalPilgrim).toBe(true);
    expect(completePayload.remainingDevoteesCount).toBe(0);

    // All devotees confirmed -> Lifecycle state is BOOKING_CONFIRMED
    const lifecycle = BookingExecutionGuard.getLifecycleState('req-multi-001');
    expect(lifecycle).toBe('BOOKING_CONFIRMED');
  });

  it('Step 5: Recoverable slot loss during devotee booking transitions to TEMPORARY_SLOT_LOST without marking terminal failure', async () => {
    mockAdapter.addToWishlistAndVerify = jest.fn().mockRejectedValue({
      errorCode: 'WISHLIST_DRAWER_NOT_FOUND',
      message: 'WISHLIST_DRAWER_NOT_FOUND: Side drawer failed to appear after 2 full page refreshes',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(twoDevoteeJob);

    expect(mockApiClient.failJob).toHaveBeenCalledTimes(1);
    const failPayload = mockApiClient.failJob.mock.calls[0][1];
    expect(failPayload.status).toBe('TEMPORARY_SLOT_LOST');

    const lifecycle = BookingExecutionGuard.getLifecycleState('req-multi-001');
    expect(lifecycle).toBe('TEMPORARY_SLOT_LOST');
  });

  it('Step 4 & Orchestrator: completeExecution on PARTIALLY_COMPLETED keeps demandKey in watch set and returns phase to WATCHING', async () => {
    const mockApiClient: any = {
      getDemandDates: jest.fn().mockResolvedValue([]),
      claimJob: jest.fn().mockResolvedValue({ hasJob: false }),
    };
    const mockHeartbeat: any = {
      isExecutionPermitted: jest.fn().mockReturnValue(true),
      isDiscoveryPermitted: jest.fn().mockReturnValue(true),
      getDesiredState: jest.fn().mockReturnValue('RUNNING'),
      setStatus: jest.fn(),
      addActiveJob: jest.fn(),
      removeActiveJob: jest.fn(),
    };
    const orchestrator = new WorkerOrchestrator(mockApiClient, mockHeartbeat, 1, 1);
    const key = '2026-11-20:PAMBA';
    const state: any = {
      demandKey: key,
      phase: 'BOOKING',
      watchStartedAt: Date.now() - 5000,
      bookingIds: ['req-multi-001'],
      pollSeq: 1,
    };
    (orchestrator as any).keyStates.set(key, state);

    // Call completeExecution with PARTIALLY_COMPLETED
    (orchestrator as any).completeExecution(key, state, 'PARTIALLY_COMPLETED', 'DEVOTEE_1_CONFIRMED');

    // Demand key must STILL be in keyStates!
    expect((orchestrator as any).keyStates.has(key)).toBe(true);
    const updatedState = (orchestrator as any).keyStates.get(key);
    expect(updatedState.phase).toBe('WATCHING');
    expect(updatedState.nextPollAt).toBeGreaterThan(Date.now() - 100);

    // By contrast, terminal SUCCESS/BOOKING_CONFIRMED removes key
    (orchestrator as any).completeExecution(key, state, 'BOOKING_CONFIRMED', 'ALL_CONFIRMED');
    expect((orchestrator as any).keyStates.has(key)).toBe(false);
  });
});
