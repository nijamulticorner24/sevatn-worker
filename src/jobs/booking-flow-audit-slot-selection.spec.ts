import { BookingWorker, BookingJobData } from './booking-worker';
import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { BookingExecutionGuard } from '../security/execution-guard';
import { SabarimalaPostLoginFlow } from '../sabarimala/post-login-flow';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

describe('Sabarimala Booking Flow Audit & Correct Slot Selection Test Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockAdapter: any;

  const sampleAccount = {
    id: 'acc-audit-01',
    username: '9876543210',
    encryptedPassword: 'enc:audit',
    encryptionIv: 'iv:audit',
    encryptionTag: 'tag:audit',
  };

  const baseJob: BookingJobData = {
    id: 'job-audit-001',
    bookingRequestId: 'req-audit-001',
    bookingCode: 'TA-AUDIT-2026',
    requestedDate: '2026-10-20',
    route: 'Pamba - Marakkoottam - 4 Kms',
    timeSlot: 'Any Slot',
    account: sampleAccount,
    pilgrims: [{ fullName: 'Sabarimala Pilgrim', age: 35, gender: 'MALE', idType: 'AADHAAR', idNumber: '998877665544' }],
    nominee: {
      nomineeName: 'Lakshmi',
      nomineeAge: 30,
      nomineeRelationship: 'Spouse',
      nomineePhone: '9876543210',
    },
    leaseGeneration: 1,
    fencingToken: 'fnc_audit_token_999',
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
      selectRequestedDate: jest.fn().mockResolvedValue({ success: true, selectedDate: '2026-10-20' }),
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
      selectPostLoginTimeSlot: jest.fn().mockResolvedValue({ success: true, selectedSlot: '05:00 - 06:00' }),
      selectPostLoginSlotWithRefreshFallback: jest.fn().mockImplementation(async (ctx: any, maxRefreshes = 3) => {
        return { success: true, selectedSlot: '05:00 - 06:00', refreshAttempts: 0 };
      }),
      reloadBookingPage: jest.fn().mockResolvedValue(undefined),
      selectBookingType: jest.fn().mockResolvedValue({ success: true, selectedType: 'Others' }),
      verifyDateTimePreserved: jest.fn().mockReturnValue(true),
      selectAllExistingPilgrims: jest.fn().mockResolvedValue({ success: true, count: 1 }),
      populateNomineeDetails: jest.fn().mockResolvedValue(true),
      handlePrasadamDetails: jest.fn().mockResolvedValue(true),
      selectReliefFundNo: jest.fn().mockResolvedValue(true),
      addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
      proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
      verifyPaymentSummary: jest.fn().mockResolvedValue(true),
      executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
        confirmed: true,
        officialReference: 'IVQ2610200000000000001',
      }),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);
  });

  // 1. Date available and slot available after login
  it('1. Date available and slot available after login: executes full portal flow cleanly', async () => {
    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Step 1: Open Darshan Availability & check date
    expect(mockAdapter.openDarshanAvailability).toHaveBeenCalled();
    expect(mockAdapter.checkRequestedDateAvailability).not.toHaveBeenCalled();

    // Step 2: Select date & route pre-login
    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledWith('2026-10-20');
    expect(mockAdapter.selectRoute).toHaveBeenCalledWith('Pamba - Marakkoottam - 4 Kms');

    // Step 3: Login via portal Login button
    expect(mockAdapter.proceedToLogin).toHaveBeenCalled();
    expect(mockAdapter.login).toHaveBeenCalledWith('9876543210', 'ValidPassword123');

    // Step 4: Covid guidelines handled
    expect(mockAdapter.handlePostLoginPopup).toHaveBeenCalled();

    // Step 5: Slot selection
    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).toHaveBeenCalled();

    // Step 8: Complete booking flow
    expect(mockAdapter.selectAllExistingPilgrims).toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).toHaveBeenCalled();
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      officialReference: 'IVQ2610200000000000001',
    }));
  });

  // 2. Slot selection occurs before any refresh
  it('2. Slot selection occurs before any refresh: immediate attempt selects slot without calling reload', async () => {
    let reloadCalled = false;
    mockAdapter.reloadBookingPage = jest.fn().mockImplementation(async () => {
      reloadCalled = true;
    });

    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockImplementation(async (ctx: any) => {
      // Direct immediate attempt without reload
      expect(reloadCalled).toBe(false);
      return { success: true, selectedSlot: '05:00 - 06:00', refreshAttempts: 0 };
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).toHaveBeenCalled();
    expect(mockAdapter.reloadBookingPage).not.toHaveBeenCalled();
    expect(reloadCalled).toBe(false);
  });

  // 3. Covid Guidelines dialog appears after login and is handled
  it('3. Covid Guidelines dialog appears after login and is handled before slot inspection', async () => {
    let dialogHandledBeforeSlotInspection = false;
    let slotInspectionAttempted = false;

    mockAdapter.handlePostLoginPopup = jest.fn().mockImplementation(async () => {
      dialogHandledBeforeSlotInspection = true;
      return true;
    });

    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockImplementation(async () => {
      slotInspectionAttempted = true;
      expect(dialogHandledBeforeSlotInspection).toBe(true);
      return { success: true, selectedSlot: '05:00 - 06:00', refreshAttempts: 0 };
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(dialogHandledBeforeSlotInspection).toBe(true);
    expect(slotInspectionAttempted).toBe(true);
  });

  // 4. No slot after login triggers the first refresh
  it('4. No slot after login triggers the first refresh in fallback loop', async () => {
    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnValue({
          isVisible: jest.fn().mockResolvedValue(false),
          waitFor: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      reload: jest.fn().mockResolvedValue(undefined),
    };

    let refreshCalled = false;
    mockPage.reload.mockImplementation(async () => {
      refreshCalled = true;
    });

    // Mock selectPostLoginTimeSlot: throws on first call (immediate), succeeds on second (after refresh)
    const originalSelect = SabarimalaPostLoginFlow.selectPostLoginTimeSlot;
    let attempt = 0;
    jest.spyOn(SabarimalaPostLoginFlow, 'selectPostLoginTimeSlot').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('SLOT_UNAVAILABLE: No slot available on immediate check');
      }
      return { success: true, selectedSlot: '07:00 - 08:00' };
    });

    const result = await SabarimalaPostLoginFlow.selectPostLoginSlotWithRefreshFallback(mockPage, {
      bookingCode: 'TA-001',
      requestedDate: '2026-10-20',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    } as any, { maxRefreshes: 3 });

    expect(refreshCalled).toBe(true);
    expect(mockPage.reload).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.selectedSlot).toBe('07:00 - 08:00');
    expect(result.refreshAttempts).toBe(1);

    (SabarimalaPostLoginFlow.selectPostLoginTimeSlot as any).mockRestore();
  });

  // 5. Slot becomes available after the first refresh
  it('5. Slot becomes available after the first refresh: successfully books after exactly 1 refresh', async () => {
    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockResolvedValue({
      success: true,
      selectedSlot: '06:00 - 07:00',
      refreshAttempts: 1,
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).toHaveBeenCalledWith(expect.any(Object), 0);
    expect(mockAdapter.selectAllExistingPilgrims).toHaveBeenCalled();
    expect(mockApiClient.completeJob).toHaveBeenCalled();
  });

  // 6. Slot becomes available after the second or third refresh
  it('6. Slot becomes available after the second or third refresh: succeeds on attempt 2 or 3', async () => {
    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnValue({
          isVisible: jest.fn().mockResolvedValue(false),
          waitFor: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      reload: jest.fn().mockResolvedValue(undefined),
    };

    let callCount = 0;
    jest.spyOn(SabarimalaPostLoginFlow, 'selectPostLoginTimeSlot').mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('SLOT_UNAVAILABLE: Slots still empty');
      }
      return { success: true, selectedSlot: '08:00 - 09:00' };
    });

    const result = await SabarimalaPostLoginFlow.selectPostLoginSlotWithRefreshFallback(mockPage, {
      bookingCode: 'TA-002',
      requestedDate: '2026-10-20',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    } as any, { maxRefreshes: 3 });

    expect(mockPage.reload).toHaveBeenCalledTimes(2);
    expect(result.refreshAttempts).toBe(2);
    expect(result.selectedSlot).toBe('08:00 - 09:00');

    (SabarimalaPostLoginFlow.selectPostLoginTimeSlot as any).mockRestore();
  });

  // 7. No slot after three refresh attempts moves the request to monitoring
  it('7. No slot after three refresh attempts moves the request to monitoring without marking booked', async () => {
    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnValue({
          isVisible: jest.fn().mockResolvedValue(false),
          waitFor: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      reload: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(SabarimalaPostLoginFlow, 'selectPostLoginTimeSlot').mockRejectedValue(
      new Error('SLOT_CARDS_MISSING: No slot cards rendered')
    );

    // selectPostLoginSlotWithRefreshFallback throws after 3 refreshes
    await expect(
      SabarimalaPostLoginFlow.selectPostLoginSlotWithRefreshFallback(mockPage, {
        bookingCode: 'TA-003',
        requestedDate: '2026-10-20',
        requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
      } as any, { maxRefreshes: 3 })
    ).rejects.toThrow(/SLOT_UNAVAILABLE.*after 3 refresh attempts/);

    expect(mockPage.reload).toHaveBeenCalledTimes(3);

    // Now test BookingWorker integration
    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockRejectedValue(
      new Error('SLOT_UNAVAILABLE: All post-login slots unavailable after 3 refresh attempts')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Must report TEMPORARY_SLOT_LOST to transition to monitoring
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'SLOT_UNAVAILABLE',
    }));

    // Must NOT mark complete or continue to pilgrims
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();

    (SabarimalaPostLoginFlow.selectPostLoginTimeSlot as any).mockRestore();
  });

  // 8. Dialog appears again after refresh
  it('8. Dialog appears again after refresh: handlePostLoginPopup called after each page reload', async () => {
    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        first: jest.fn().mockReturnValue({
          isVisible: jest.fn().mockResolvedValue(false),
          waitFor: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      reload: jest.fn().mockResolvedValue(undefined),
    };

    let popupCheckCount = 0;
    jest.spyOn(SabarimalaPostLoginFlow, 'handlePostLoginPopup').mockImplementation(async () => {
      popupCheckCount++;
      return true;
    });

    let slotCalls = 0;
    jest.spyOn(SabarimalaPostLoginFlow, 'selectPostLoginTimeSlot').mockImplementation(async () => {
      slotCalls++;
      if (slotCalls === 1) throw new Error('SLOT_UNAVAILABLE');
      return { success: true, selectedSlot: '05:00 - 06:00' };
    });

    await SabarimalaPostLoginFlow.selectPostLoginSlotWithRefreshFallback(mockPage, {
      bookingCode: 'TA-004',
      requestedDate: '2026-10-20',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    } as any, { maxRefreshes: 3 });

    // Checked once on initial attempt (attempt 0) and once after refresh 1
    expect(popupCheckCount).toBe(2);

    (SabarimalaPostLoginFlow.handlePostLoginPopup as any).mockRestore();
    (SabarimalaPostLoginFlow.selectPostLoginTimeSlot as any).mockRestore();
  });

  // 9. Slot becomes disabled between inspection and click
  it('9. Slot becomes disabled between inspection and click: triggers refresh fallback rather than silent continuation', async () => {
    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockRejectedValue(
      new Error('SLOT_SELECTION_UNVERIFIED: Clicked slot card 05:00 - 06:00 but official portal did not accept the selection (.slot-dar-5 missing).')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'SLOT_SELECTION_UNVERIFIED',
    }));
  });

  // 10. Slot selection fails and the worker does not proceed to passenger details
  it('10. Slot selection fails and worker strictly stops before passenger details', async () => {
    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockRejectedValue(
      new Error('SLOT_UNAVAILABLE: All post-login slots are fully booked or closed after 3 refresh attempts')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();
    expect(mockAdapter.populateNomineeDetails).not.toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  // 11. Successful slot selection proceeds to the existing booking flow
  it('11. Successful slot selection proceeds seamlessly through complete existing booking sequence', async () => {
    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).toHaveBeenCalled();
    expect(mockAdapter.selectBookingType).toHaveBeenCalled();
    expect(mockAdapter.selectAllExistingPilgrims).toHaveBeenCalled();
    expect(mockAdapter.populateNomineeDetails).toHaveBeenCalled();
    expect(mockAdapter.handlePrasadamDetails).toHaveBeenCalled();
    expect(mockAdapter.selectReliefFundNo).toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).toHaveBeenCalled();
    expect(mockAdapter.proceedToPaymentGateway).toHaveBeenCalled();
    expect(mockAdapter.verifyPaymentSummary).toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).toHaveBeenCalled();
    expect(mockApiClient.completeJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      officialReference: 'IVQ2610200000000000001',
    }));
  });

  // 12. No duplicate booking or unsafe lock/lease behavior occurs
  it('12. No duplicate booking or unsafe lock/lease behavior occurs: rejects overlapping dispatch and passes fencing token', async () => {
    // 1. Acquire lock to simulate concurrent in-flight job
    const lock = BookingExecutionGuard.acquire({
      bookingId: 'req-audit-001',
      bookingCode: 'TA-AUDIT-2026',
      jobId: 'job-existing',
      dispatchSource: 'PENDING_MONITOR',
      owner: 'FIRST_WORKER',
    });
    expect(lock.acquired).toBe(true);

    const worker = new BookingWorker(mockApiClient);
    // 2. Dispatch duplicate attempt for the same booking
    await worker.execute({
      ...baseJob,
      id: 'job-duplicate-002',
    });

    // Must NOT start adapter or proceed with login
    expect(mockAdapter.init).not.toHaveBeenCalled();
    expect(mockAdapter.login).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();

    // Clean up lock
    BookingExecutionGuard.release('req-audit-001', 'job-existing');
  });

  // 13. Live portal sequence: selects date and route on darshanAvailability BEFORE clicking Login button
  it('13. Live portal sequence: selects date and route on darshanAvailability BEFORE clicking Login button', async () => {
    const callOrder: string[] = [];

    mockAdapter.openDarshanAvailability = jest.fn().mockImplementation(async () => {
      callOrder.push('openDarshanAvailability');
      return { success: true };
    });
    mockAdapter.selectRequestedDate = jest.fn().mockImplementation(async () => {
      callOrder.push('selectRequestedDate');
      return { success: true };
    });
    mockAdapter.selectRoute = jest.fn().mockImplementation(async () => {
      callOrder.push('selectRoute');
      return { success: true };
    });
    mockAdapter.proceedToLogin = jest.fn().mockImplementation(async () => {
      callOrder.push('proceedToLogin');
      return { success: true };
    });
    mockAdapter.login = jest.fn().mockImplementation(async () => {
      callOrder.push('login');
      return { status: 'LOGIN_SUCCESS' };
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Verify exact ordering: open -> selectDate -> selectRoute -> proceedToLogin -> login (no redundant check)
    expect(callOrder).toEqual([
      'openDarshanAvailability',
      'selectRequestedDate',
      'selectRoute',
      'proceedToLogin',
      'login',
    ]);
    expect(mockAdapter.checkRequestedDateAvailability).not.toHaveBeenCalled();
    expect(mockAdapter.openLogin).not.toHaveBeenCalled();
  });

  // 14. Live portal sequence: slot refresh retries occur ONLY after successful login
  it('14. Live portal sequence: slot refresh retries occur ONLY after successful login', async () => {
    const callOrder: string[] = [];

    mockAdapter.login = jest.fn().mockImplementation(async () => {
      callOrder.push('login');
      return { status: 'LOGIN_SUCCESS' };
    });
    mockAdapter.handlePostLoginPopup = jest.fn().mockImplementation(async () => {
      callOrder.push('handlePostLoginPopup');
      return true;
    });
    mockAdapter.verifyCarriedDateAndRoute = jest.fn().mockImplementation(async () => {
      callOrder.push('verifyCarriedDateAndRoute');
      return true;
    });
    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockImplementation(async (ctx: any, maxRefreshes: number) => {
      callOrder.push('selectPostLoginSlotWithRefreshFallback');
      return { success: true, selectedSlot: '05:00 - 06:00', refreshAttempts: 1 };
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    // Verify slot refresh attempt happens after login, popup, and carried date/route verification
    const loginIdx = callOrder.indexOf('login');
    const popupIdx = callOrder.indexOf('handlePostLoginPopup');
    const verifyIdx = callOrder.indexOf('verifyCarriedDateAndRoute');
    const slotIdx = callOrder.indexOf('selectPostLoginSlotWithRefreshFallback');

    expect(loginIdx).toBeGreaterThan(-1);
    expect(popupIdx).toBeGreaterThan(loginIdx);
    expect(verifyIdx).toBeGreaterThan(popupIdx);
    expect(slotIdx).toBeGreaterThan(verifyIdx);
  });

  // 15. Slot selection failure after 3 retries: calls adapter.logout() and transitions to TEMPORARY_SLOT_LOST
  it('15. Slot selection failure after 3 retries: calls adapter.logout() and transitions to TEMPORARY_SLOT_LOST', async () => {
    mockAdapter.selectPostLoginSlotWithRefreshFallback = jest.fn().mockRejectedValue(
      new Error('SLOT_UNAVAILABLE: All slots unavailable after 3 refresh attempts')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.logout).toHaveBeenCalled();
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'SLOT_UNAVAILABLE',
    }));
    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  // 16. Mismatched date or route carried after login halts execution immediately and logs out
  it('16. Mismatched date or route carried after login halts execution immediately and logs out', async () => {
    mockAdapter.verifyCarriedDateAndRoute = jest.fn().mockRejectedValue(
      new Error('MISMATCHED_DATE: Carried date is 2026-10-21 but requested 2026-10-20')
    );

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.logout).toHaveBeenCalled();
    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).not.toHaveBeenCalled();
    expect(mockAdapter.selectAllExistingPilgrims).not.toHaveBeenCalled();
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'MISMATCHED_DATE',
    }));
  });

  // 17. Date selection failure stops immediately without route selection or login
  it('17. Date selection failure (selectRequestedDate returns success: false) stops flow immediately', async () => {
    mockAdapter.selectRequestedDate = jest.fn().mockResolvedValue({
      success: false,
      error: 'Date cell 2026-10-20 is disabled (FULL)',
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.selectRequestedDate).toHaveBeenCalledWith('2026-10-20');
    expect(mockAdapter.selectRoute).not.toHaveBeenCalled();
    expect(mockAdapter.proceedToLogin).not.toHaveBeenCalled();
    expect(mockAdapter.login).not.toHaveBeenCalled();
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'DATE_NOT_SELECTABLE',
    }));
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  // 18. Date/route verification returning false aborts without re-selection or proceeding to slot selection
  it('18. Date/route verification returning false aborts without re-selection or slot selection', async () => {
    mockAdapter.verifyCarriedDateAndRoute = jest.fn().mockResolvedValue(false);

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.verifyCarriedDateAndRoute).toHaveBeenCalled();
    expect(mockAdapter.selectAuthenticatedDateAndRoute).not.toHaveBeenCalled();
    expect(mockAdapter.selectPostLoginSlotWithRefreshFallback).not.toHaveBeenCalled();
    expect(mockAdapter.logout).toHaveBeenCalled();
    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      status: 'TEMPORARY_SLOT_LOST',
      errorCode: 'DATE_ROUTE_MISMATCH',
    }));
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  // 19. Failure never becomes SUCCESS: completeJob is never called on any failure outcome
  it('19. Failure never becomes SUCCESS: errors strictly call failJob, never completeJob', async () => {
    mockAdapter.openDarshanAvailability = jest.fn().mockResolvedValue({ success: false });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockApiClient.failJob).toHaveBeenCalledWith('job-audit-001', expect.objectContaining({
      status: 'SITE_ERROR',
    }));
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
  });

  // 20. HTTP 409 conflict on updateJobProgress (e.g. STALE_LEASE_GENERATION) halts execution before final confirmation
  it('20. HTTP 409 conflict on updateJobProgress (e.g. at PILGRIMS_VERIFIED) halts execution safely before submission and logs out', async () => {
    const error409: any = new Error('Request failed with status code 409');
    error409.response = {
      status: 409,
      data: {
        statusCode: 409,
        message: 'Stale lease generation (STALE_LEASE_GENERATION)',
        error: 'Conflict',
      },
    };

    mockApiClient.updateJobProgress = jest.fn().mockImplementation((jobId: string, data: any) => {
      if (data.status === 'PILGRIMS_VERIFIED') {
        throw error409;
      }
      return Promise.resolve({ success: true, status: data.status });
    });

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(baseJob);

    expect(mockAdapter.logout).toHaveBeenCalled();
    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
    // Verify execution lock was safely released and not left active
    expect(BookingExecutionGuard.isBookingActive(baseJob.bookingRequestId)).toBe(false);
    expect(mockApiClient.failJob).not.toHaveBeenCalled();
  });

  // 21. When active lease is lost during execution, worker refuses to submit confirmation
  it('21. When active lease is lost, worker aborts before checkout/confirmation without calling completeJob', async () => {
    const leaseLostJob = {
      ...baseJob,
      leaseLost: true,
    };

    const worker = new BookingWorker(mockApiClient);
    await worker.execute(leaseLostJob);

    expect(mockAdapter.addToWishlistAndVerify).not.toHaveBeenCalled();
    expect(mockAdapter.executePaymentProceedAndConfirm).not.toHaveBeenCalled();
    expect(mockApiClient.completeJob).not.toHaveBeenCalled();
    expect(mockAdapter.logout).toHaveBeenCalled();
  });
});
