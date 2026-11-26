import { BookingWorker } from './booking-worker';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { SanitizedLogger } from '../monitoring/logger';
import { BookingExecutionGuard } from '../security/execution-guard';
import { PilgrimSelectionFlow } from '../sabarimala/flows/pilgrim-selection.flow';
import { BookingExecutionContext } from '../sabarimala/flows/types';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

function createMockLocator(overrides: Record<string, any> = {}): any {
  const loc: any = {
    count: jest.fn().mockResolvedValue(1),
    first: jest.fn().mockImplementation(() => loc),
    last: jest.fn().mockImplementation(() => loc),
    nth: jest.fn().mockImplementation(() => loc),
    locator: jest.fn().mockImplementation(() => loc),
    isVisible: jest.fn().mockResolvedValue(true),
    isDisabled: jest.fn().mockResolvedValue(false),
    isChecked: jest.fn().mockResolvedValue(false),
    innerText: jest.fn().mockResolvedValue(''),
    getAttribute: jest.fn().mockResolvedValue(null),
    evaluate: jest.fn().mockResolvedValue(false),
    click: jest.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
    waitFor: jest.fn().mockResolvedValue(undefined),
    dispatchEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return loc;
}

describe('Sequential Devotee Booking — Never Select an Already Confirmed Devotee', () => {
  let infoLogs: string[] = [];
  let warnLogs: string[] = [];
  let errorLogs: string[] = [];

  beforeEach(() => {
    BookingExecutionGuard.clearAll();
    infoLogs = [];
    warnLogs = [];
    errorLogs = [];
    jest.spyOn(SanitizedLogger, 'info').mockImplementation((msg: string) => {
      infoLogs.push(msg);
    });
    jest.spyOn(SanitizedLogger, 'warn').mockImplementation((msg: string) => {
      warnLogs.push(msg);
    });
    jest.spyOn(SanitizedLogger, 'error').mockImplementation((msg: string) => {
      errorLogs.push(msg);
    });
    (CredentialManager.decrypt as jest.Mock).mockReturnValue('ValidPassword123');
  });

  afterEach(() => {
    BookingExecutionGuard.clearAll();
    jest.restoreAllMocks();
  });

  const baseNominee = {
    nomineeName: 'Duraisamy Nominee',
    nomineeAge: 58,
    nomineeRelationship: 'FATHER',
    nomineePhone: '9876543210',
  };

  const accountData = {
    id: 'acc-ta-10015',
    username: 'sabarimala_user_1',
    encryptedPassword: 'enc:pass',
    encryptionIv: 'iv:mock',
    encryptionTag: 'tag:mock',
  };

  // Test A — First devotee: Given 3 pending devotees and 0 confirmed -> Expected next devotee = #1 BASKAR DURAISAMY
  it('Test A — First devotee: Given 3 pending devotees and 0 confirmed -> Expected next devotee = #1 BASKAR DURAISAMY', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    let selectedPilgrimPassed: any = null;
    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedPilgrimPassed = ctx.targetDevotee;
        return {
          success: true,
          selectedPilgrim: { fullName: 'BASKAR DURAISAMY', identityFingerprint: 'fp_baskar_1' },
        };
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814227',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const jobPayload: any = {
      id: 'job-test-a',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 1,
      fencingToken: 'fence-test-a',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: [
        { id: 'p-1', fullName: 'BASKAR DURAISAMY', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
        { id: 'p-2', fullName: 'GUNA', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
        { id: 'p-3', fullName: 'ARUL', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      ],
    };

    await worker.execute(jobPayload);

    // Assert: Devotee #1 (BASKAR DURAISAMY) was selected
    expect(selectedPilgrimPassed).toEqual(
      expect.objectContaining({ sequence: 1, fullName: 'BASKAR DURAISAMY' }),
    );
    expect(infoLogs.some((l) => l.includes('[SEQUENTIAL-BOOKING]') && l.includes('nextDevoteeSequence=1') && l.includes('nextDevoteeName=BASKAR DURAISAMY'))).toBe(true);
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-test-a',
      expect.objectContaining({
        officialReference: '1928814227',
        taskIndex: 1,
        isFinalPilgrim: false,
      }),
    );
  });

  // Test B — Move to second devotee: Given 3 requested devotees and Devotee #1 confirmed -> Expected next devotee = #2 GUNA. Assert that BASKAR is not selected again.
  it('Test B — Move to second devotee: Given 3 requested devotees and Devotee #1 confirmed -> Expected next devotee = #2 GUNA. Assert that BASKAR is not selected again.', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    let selectedPilgrimPassed: any = null;
    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedPilgrimPassed = ctx.targetDevotee;
        return {
          success: true,
          selectedPilgrim: { fullName: 'GUNA', identityFingerprint: 'fp_guna_2' },
        };
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814228',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const jobPayload: any = {
      id: 'job-test-b',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 2,
      fencingToken: 'fence-test-b',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: [
        {
          id: 'p-1',
          fullName: 'BASKAR DURAISAMY',
          metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: '1928814227', identityFingerprint: 'fp_baskar_1' },
        },
        { id: 'p-2', fullName: 'GUNA', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
        { id: 'p-3', fullName: 'ARUL', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      ],
    };

    await worker.execute(jobPayload);

    // Assert: Devotee #2 (GUNA) was selected, NOT Devotee #1 (BASKAR)
    expect(selectedPilgrimPassed).toEqual(
      expect.objectContaining({ sequence: 2, fullName: 'GUNA' }),
    );
    expect(selectedPilgrimPassed.fullName).not.toBe('BASKAR DURAISAMY');
    expect(infoLogs.some((l) => l.includes('[SEQUENTIAL-BOOKING]') && l.includes('nextDevoteeSequence=2') && l.includes('nextDevoteeName=GUNA'))).toBe(true);
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-test-b',
      expect.objectContaining({
        officialReference: '1928814228',
        taskIndex: 2,
        isFinalPilgrim: false,
      }),
    );
  });

  // Test C — Move to third devotee: Given Devotees #1 and #2 confirmed -> Expected next devotee = #3 ARUL. Assert that neither BASKAR nor GUNA is selected again.
  it('Test C — Move to third devotee: Given Devotees #1 and #2 confirmed -> Expected next devotee = #3 ARUL. Assert that neither BASKAR nor GUNA is selected again.', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    let selectedPilgrimPassed: any = null;
    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedPilgrimPassed = ctx.targetDevotee;
        return {
          success: true,
          selectedPilgrim: { fullName: 'ARUL', identityFingerprint: 'fp_arul_3' },
        };
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814229',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const jobPayload: any = {
      id: 'job-test-c',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 3,
      fencingToken: 'fence-test-c',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: [
        {
          id: 'p-1',
          fullName: 'BASKAR DURAISAMY',
          metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: '1928814227' },
        },
        {
          id: 'p-2',
          fullName: 'GUNA',
          metadata: { taskIndex: 2, taskStatus: 'CONFIRMED', officialBookingReference: '1928814228' },
        },
        { id: 'p-3', fullName: 'ARUL', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      ],
    };

    await worker.execute(jobPayload);

    // Assert: Devotee #3 (ARUL) was selected, NOT BASKAR or GUNA
    expect(selectedPilgrimPassed).toEqual(
      expect.objectContaining({ sequence: 3, fullName: 'ARUL' }),
    );
    expect(selectedPilgrimPassed.fullName).not.toBe('BASKAR DURAISAMY');
    expect(selectedPilgrimPassed.fullName).not.toBe('GUNA');
    expect(infoLogs.some((l) => l.includes('[SEQUENTIAL-BOOKING]') && l.includes('nextDevoteeSequence=3') && l.includes('nextDevoteeName=ARUL'))).toBe(true);
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-test-c',
      expect.objectContaining({
        officialReference: '1928814229',
        taskIndex: 3,
        isFinalPilgrim: true,
      }),
    );
  });

  // Test D — All devotees confirmed: Given all 3 devotees confirmed -> Expected booking status = COMPLETED. Assert that no new booking attempt is created.
  it('Test D — All devotees confirmed: Given all 3 devotees confirmed -> Expected booking status = COMPLETED. Assert that no new booking attempt is created.', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      selectSingleSavedPilgrim: jest.fn(),
      executePaymentProceedAndConfirm: jest.fn(),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const jobPayload: any = {
      id: 'job-test-d',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 4,
      fencingToken: 'fence-test-d',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: [
        { id: 'p-1', fullName: 'BASKAR DURAISAMY', metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: '1928814227' } },
        { id: 'p-2', fullName: 'GUNA', metadata: { taskIndex: 2, taskStatus: 'CONFIRMED', officialBookingReference: '1928814228' } },
        { id: 'p-3', fullName: 'ARUL', metadata: { taskIndex: 3, taskStatus: 'CONFIRMED', officialBookingReference: '1928814229' } },
      ],
    };

    await worker.execute(jobPayload);

    // Assert: Worker recognizes all 3 already confirmed and exits without launching browser or new booking
    expect(mockAdapter.init).not.toHaveBeenCalled();
    expect(mockAdapter.selectSingleSavedPilgrim).not.toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).not.toHaveBeenCalled();
    expect(infoLogs.some((l) => l.includes('[SEQUENTIAL-BOOKING] All 3 devotees already confirmed'))).toBe(true);
    expect(BookingExecutionGuard.getLifecycleState('TA-10015')).toBe('BOOKING_CONFIRMED');
  });

  // Test E — Failed booking attempt: Given Devotee #1 is pending and the slot fails -> Expected next devotee remains #1. Assert that the worker does not advance to #2.
  it('Test E — Failed booking attempt: Given Devotee #1 is pending and the slot fails -> Expected next devotee remains #1. Assert that the worker does not advance to #2.', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      // Slot becomes unavailable after login
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockRejectedValue(new Error('SLOT_UNAVAILABLE: Slot unavailable')),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);
    const jobPayload: any = {
      id: 'job-test-e',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 1,
      fencingToken: 'fence-test-e',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: [
        { id: 'p-1', fullName: 'BASKAR DURAISAMY', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
        { id: 'p-2', fullName: 'GUNA', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
        { id: 'p-3', fullName: 'ARUL', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      ],
    };

    await worker.execute(jobPayload);

    // Assert: Failed job reports failure, does not call completeJob, devotee #1 remains pending
    expect(mockApiClient.failJob).toHaveBeenCalledWith(
      'job-test-e',
      expect.objectContaining({ status: 'TEMPORARY_SLOT_LOST' }),
    );
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  // Test F — Worker restart: Persist Devotee #1 as confirmed, restart/reload the booking state, and create a new attempt. Expected next devotee = #2 GUNA.
  it('Test F — Worker restart: Persist Devotee #1 as confirmed, restart/reload the booking state, and create a new attempt. Expected next devotee = #2 GUNA.', async () => {
    // Simulate worker process restart by creating a brand new worker instance and clearing locks
    BookingExecutionGuard.clearAll();

    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    let selectedDevoteeOnRestart: any = null;
    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedDevoteeOnRestart = ctx.targetDevotee;
        return {
          success: true,
          selectedPilgrim: { fullName: 'GUNA', identityFingerprint: 'fp_guna_2' },
        };
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814228',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const restartedWorker = new BookingWorker(mockApiClient);

    // Reloaded job payload from database (metadata parsed or serialized string)
    const reloadedJobPayload: any = {
      id: 'job-test-f-restart',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 2,
      fencingToken: 'fence-test-f',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: [
        {
          id: 'p-1',
          fullName: 'BASKAR DURAISAMY',
          metadata: JSON.stringify({ taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: '1928814227' }),
        },
        {
          id: 'p-2',
          fullName: 'GUNA',
          metadata: JSON.stringify({ taskIndex: 2, taskStatus: 'PENDING' }),
        },
        {
          id: 'p-3',
          fullName: 'ARUL',
          metadata: JSON.stringify({ taskIndex: 3, taskStatus: 'PENDING' }),
        },
      ],
    };

    await restartedWorker.execute(reloadedJobPayload);

    // Assert: Even after restart and JSON-stringified metadata, devotee #2 (GUNA) is selected
    expect(selectedDevoteeOnRestart).toEqual(
      expect.objectContaining({ sequence: 2, fullName: 'GUNA' }),
    );
    expect(infoLogs.some((l) => l.includes('nextDevoteeSequence=2') && l.includes('nextDevoteeName=GUNA'))).toBe(true);
  });

  // Test G — Stale queue job: A stale queue job tries to select Devotee #1 after confirmation. Expected result: duplicate selection is blocked and the next pending devotee is selected.
  it('Test G — Stale queue job: A stale queue job tries to select Devotee #1 after confirmation. Expected result: duplicate selection is blocked and the next pending devotee is selected.', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({}),
      completeJob: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({}),
    };

    let selectedDevotee: any = null;
    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedDevotee = ctx.targetDevotee;
        return {
          success: true,
          selectedPilgrim: { fullName: 'GUNA', identityFingerprint: 'fp_guna_2' },
        };
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814228',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    // Stale payload arrives where Devotee #1 is already confirmed in DB
    const staleJobPayload: any = {
      id: 'job-test-g-stale',
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      leaseGeneration: 2,
      fencingToken: 'fence-test-g',
      requestedDate: '2026-11-30',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      nominee: baseNominee,
      account: accountData,
      pilgrims: [
        { id: 'p-1', fullName: 'BASKAR DURAISAMY', metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: '1928814227' } },
        { id: 'p-2', fullName: 'GUNA', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
        { id: 'p-3', fullName: 'ARUL', metadata: { taskIndex: 3, taskStatus: 'PENDING' } },
      ],
    };

    await worker.execute(staleJobPayload);

    // Assert: Devotee #1 is skipped and Devotee #2 (GUNA) is selected
    expect(selectedDevotee.sequence).toBe(2);
    expect(selectedDevotee.fullName).toBe('GUNA');
    expect(mockApiClient.completeJob).toHaveBeenCalledWith(
      'job-test-g-stale',
      expect.objectContaining({ taskIndex: 2 }),
    );
  });

  // Test H — Portal profile mapping: Ensure the requested booking devotee is matched to the correct saved portal profile, rather than always selecting saved pilgrim Row 1.
  it('Test H — Portal profile mapping: Ensure the requested booking devotee is matched to the correct saved portal profile, rather than always selecting saved pilgrim Row 1.', async () => {
    // Official portal contains 8 saved pilgrim records in arbitrary order
    const portalPilgrims = [
      { row: 1, fullName: 'BASKAR DURAISAMY', gender: 'Male', idType: 'Aadhaar', idTail: '1234' },
      { row: 2, fullName: 'RAMESH KUMAR', gender: 'Male', idType: 'Aadhaar', idTail: '5678' },
      { row: 3, fullName: 'GUNA', gender: 'Male', idType: 'Aadhaar', idTail: '9988' },
      { row: 4, fullName: 'ARUL', gender: 'Male', idType: 'Voter ID', idTail: '4455' },
      { row: 5, fullName: 'SURESH', gender: 'Male', idType: 'Aadhaar', idTail: '3322' },
      { row: 6, fullName: 'DEVARAJ', gender: 'Male', idType: 'Aadhaar', idTail: '1122' },
      { row: 7, fullName: 'VIJAY', gender: 'Male', idType: 'Passport', idTail: '7788' },
      { row: 8, fullName: 'MOHAN', gender: 'Male', idType: 'Aadhaar', idTail: '6655' },
    ];

    let clickedRowIndex = -1;
    let checkedRows = new Set<number>();

    const mockPage: any = {
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('Select Pilgrim') || sel.includes('Add Pilgrim')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockResolvedValue(undefined),
          });
        }
        if (sel === 'table tbody tr, mat-row') {
          return {
            count: jest.fn().mockResolvedValue(portalPilgrims.length),
            nth: jest.fn().mockImplementation((idx: number) => {
              const p = portalPilgrims[idx];
              const rowText = `${p.row}\t${p.fullName}\t35\t${p.gender}\t${p.idType}\tXXXX-XXXX-${p.idTail}`;
              return {
                innerText: jest.fn().mockResolvedValue(rowText),
                locator: jest.fn().mockImplementation((subSel: string) => {
                  return {
                    first: jest.fn().mockReturnValue({
                      isVisible: jest.fn().mockResolvedValue(true),
                      isChecked: jest.fn().mockImplementation(async () => checkedRows.has(idx)),
                      evaluate: jest.fn().mockImplementation(async (cb: any) => checkedRows.has(idx)),
                      getAttribute: jest.fn().mockResolvedValue(`cb-portal-${idx}`),
                      click: jest.fn().mockImplementation(async () => {
                        clickedRowIndex = idx;
                        checkedRows.add(idx);
                      }),
                      locator: jest.fn().mockReturnValue({
                        first: jest.fn().mockReturnValue({
                          isVisible: jest.fn().mockResolvedValue(true),
                          click: jest.fn().mockImplementation(async () => {
                            clickedRowIndex = idx;
                            checkedRows.add(idx);
                          }),
                        }),
                      }),
                    }),
                  };
                }),
              };
            }),
          };
        }
        return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
      }),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
    };

    // Execution Context targeting Devotee #2: GUNA
    // Devotee #1 (BASKAR DURAISAMY) is already confirmed
    const ctx: BookingExecutionContext = {
      bookingId: 'req-ta-10015',
      bookingCode: 'TA-10015',
      requestedDate: '2026-11-30',
      requestedDateDisplay: '30-11-2026',
      requestedRoute: 'Pamba',
      pilgrimCount: 1,
      reliefFund: 0,
      currentPilgrimIndex: 1,
      targetDevotee: {
        id: 'p-2',
        sequence: 2,
        fullName: 'GUNA',
      },
      confirmedDevotees: [
        {
          id: 'p-1',
          sequence: 1,
          fullName: 'BASKAR DURAISAMY',
          officialBookingReference: '1928814227',
        },
      ],
      pilgrims: [
        {
          id: 'p-2',
          fullName: 'GUNA',
          metadata: { taskIndex: 2, taskStatus: 'PENDING' },
        } as any,
      ],
    };

    const result = await PilgrimSelectionFlow.execute(mockPage, ctx);

    // INVARIANTS ASSERTION:
    // 1. Selection succeeded
    expect(result.success).toBe(true);
    expect(result.selectedCount).toBe(1);

    // 2. Row 1 (BASKAR DURAISAMY) was blocked and skipped with [DUPLICATE-DEVOTEE-BLOCKED]
    expect(warnLogs.some((l) => l.includes('[DUPLICATE-DEVOTEE-BLOCKED]') && l.includes('devoteeSequence=1') && l.includes('BASKAR DURAISAMY'))).toBe(true);

    // 3. Worker DID NOT select Row 1 simply because it is Row 1!
    expect(clickedRowIndex).not.toBe(0); // Row 0 is BASKAR

    // 4. Worker mapped and selected Row 3 (index 2: GUNA)
    expect(clickedRowIndex).toBe(2); // Index 2 is GUNA (Row 3)
    expect(result.selectedPilgrim.fullName).toBe('GUNA');

    // 5. Structured log [PILGRIM-SELECTION] was recorded
    expect(infoLogs.some((l) => l.includes('[PILGRIM-SELECTION]') && l.includes('devoteeSequence=2') && l.includes('devoteeName=GUNA') && l.includes('savedProfileMatch=GUNA (Row 3)'))).toBe(true);
  });

  it('Test I — Devotee #1 in RECONCILIATION_REQUIRED is deferred to queue end, allowing Devotee #2 to be selected without blocking', async () => {
    const mockApiClient: any = {
      updateJobProgress: jest.fn().mockResolvedValue({ success: true }),
      failJob: jest.fn().mockResolvedValue({ success: true }),
      completeJob: jest.fn().mockResolvedValue({ success: true, isAllConfirmed: false }),
    };

    let selectedPilgrimPassed: any = null;
    const mockAdapter: any = {
      init: jest.fn().mockResolvedValue(undefined),
      getPage: jest.fn().mockReturnValue({}),
      openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
      checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true }),
      openLogin: jest.fn().mockResolvedValue(true),
      login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
      handlePostLoginPopup: jest.fn().mockResolvedValue(true),
      initialWishlistCleanup: jest.fn().mockResolvedValue(true),
      verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '16:00 - 17:00' }),
      selectBookingType: jest.fn().mockResolvedValue(true),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectSingleSavedPilgrim: jest.fn().mockImplementation(async (ctx: any) => {
        selectedPilgrimPassed = ctx.targetDevotee;
        return {
          success: true,
          selectedPilgrim: { fullName: 'GUNA', identityFingerprint: 'fp_guna_2' },
        };
      }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: '1928814999',
      }),
      logout: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    };
    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    const worker = new BookingWorker(mockApiClient);

    const jobData: any = {
      id: 'job-reconciliation-01',
      bookingRequestId: 'req-ta-10020',
      bookingCode: 'TA-10020',
      requestedDate: '2026-11-28',
      route: 'Pamba',
      selectedTime: '16:00 - 17:00',
      pilgrimCount: 3,
      leaseGeneration: 1,
      fencingToken: 'token-abc',
      nominee: baseNominee,
      account: accountData,
      // Devotee #1 has taskStatus: 'RECONCILIATION_REQUIRED', Devotees #2 and #3 are PENDING
      pilgrims: [
        {
          id: 'p-1',
          fullName: 'BASKAR DURAISAMY',
          metadata: JSON.stringify({ taskIndex: 1, taskStatus: 'RECONCILIATION_REQUIRED' }),
        },
        {
          id: 'p-2',
          fullName: 'GUNA',
          metadata: JSON.stringify({ taskIndex: 2, taskStatus: 'PENDING' }),
        },
        {
          id: 'p-3',
          fullName: 'ARUL',
          metadata: JSON.stringify({ taskIndex: 3, taskStatus: 'PENDING' }),
        },
      ],
    };

    (CredentialManager.decrypt as jest.Mock).mockReturnValue('secret123');

    await worker.execute(jobData);

    // Verify structured log: Devotee #1 was deferred, and Devotee #2 (GUNA) was selected next!
    const seqLog = infoLogs.find((l) => l.includes('[SEQUENTIAL-BOOKING]') && l.includes('nextDevoteeSequence=2'));
    expect(seqLog).toBeDefined();
    expect(seqLog).toContain('nextDevoteeName=GUNA');
    expect(seqLog).toContain('nextDevoteeSequence=2');
    expect(selectedPilgrimPassed.fullName).toBe('GUNA');
  });
});
