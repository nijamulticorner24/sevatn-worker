import { BookingWorker, BookingJobData } from './booking-worker';
import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { BookingExecutionGuard } from '../security/execution-guard';
import { ConfirmMarkerManager } from '../security/confirm-marker';
import { SabarimalaPostLoginFlow } from '../sabarimala/post-login-flow';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

describe('False Confirmation Reconciliation & Authoritative Ticket Verification Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockAdapter: any;

  const sampleAccount = {
    id: 'acc-recon-01',
    username: '9876543210',
    encryptedPassword: 'enc:recon',
    encryptionIv: 'iv:recon',
    encryptionTag: 'tag:recon',
  };

  const sampleJob: BookingJobData = {
    id: 'job-ta-10003',
    bookingRequestId: 'req-ta-10003',
    bookingCode: 'TA-10003',
    requestedDate: '2026-11-26',
    route: 'Pamba - Marakkoottam - 4 Kms',
    timeSlot: '05:00 - 06:00',
    account: sampleAccount,
    pilgrimCount: 1,
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
    ],
    leaseGeneration: 1,
    fencingToken: 'fnc_token_10003',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    BookingExecutionGuard.clearAll();
    ConfirmMarkerManager.clearMarker('TA-10003');

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
      selectRequestedDate: jest.fn().mockResolvedValue({ success: true, selectedDate: '2026-11-26' }),
      selectRoute: jest.fn().mockResolvedValue({ success: true, selectedRoute: 'Pamba - Marakkoottam - 4 Kms' }),
      discoverAvailableSlots: jest.fn().mockResolvedValue([{ slotName: '05:00 - 06:00', availabilityCount: 100 }]),
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
        officialReference: 'IVQ2611269999999999999',
      }),
      checkExistingBookingInHistory: jest.fn().mockResolvedValue({ found: false }),
    };

    (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);
  });

  describe('Part 1: Unit tests for SabarimalaPostLoginFlow.checkExistingBookingInHistory', () => {
    it('1. Reference appears in page body text but no confirmed pass exists in table → returns found: false (NOT CONFIRMED)', async () => {
      // Mock page where bodyText contains reference IVQ26112610553511816261 and the date, but table has no confirmed rows
      const mockPage: any = {
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(0),
        }),
        innerText: jest.fn().mockResolvedValue('Some debug log text with IVQ26112610553511816261 and date 26-11-2026 without any table'),
      };

      const result = await SabarimalaPostLoginFlow.checkExistingBookingInHistory(mockPage, {
        requestedDate: '2026-11-26',
        requestedDateDisplay: '26-11-2026',
      } as any);

      // Must NEVER return found: true based on bodyText match!
      expect(result.found).toBe(false);
      expect(result.decision).toBe('RECONCILIATION_REQUIRED');
      expect(result.reconciliationRequired).toBe(true);
    });

    it('2. Transaction status CANCELLED and pilgrim count 0 → returns found: false and officialStatusFound: CANCELLED', async () => {
      // Exactly the TA-10003 production scenario:
      // Row contains IVQ26112610553511816261, date 26-11-2026, status CANCELLED, 0 Pilgrims
      const cancelledRowText =
        'Ref: IVQ26112610553511816261 | Date: 26-11-2026 | Virtual Q Darshan | Pilgrims: 0 | Amount: ₹0 | Status: Cancelled';

      const mockRow = {
        innerText: jest.fn().mockResolvedValue(cancelledRowText),
        locator: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(0),
        }),
      };

      const mockPage: any = {
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockImplementation((sel: string) => {
          if (sel === 'table tbody tr') {
            return {
              count: jest.fn().mockResolvedValue(1),
              nth: jest.fn().mockReturnValue(mockRow),
            };
          }
          return { count: jest.fn().mockResolvedValue(0) };
        }),
        innerText: jest.fn().mockResolvedValue(cancelledRowText),
      };

      const result = await SabarimalaPostLoginFlow.checkExistingBookingInHistory(mockPage, {
        requestedDate: '2026-11-26',
        requestedDateDisplay: '26-11-2026',
      } as any);

      expect(result.found).toBe(false);
      expect(result.officialStatusFound).toBe('CANCELLED');
      expect(result.decision).toBe('RECONCILIATION_REQUIRED');
      expect(result.reconciliationRequired).toBe(true);
    });

    it('3. Payment/cart reference exists but ticket is absent / status PENDING → returns found: false', async () => {
      const pendingRowText =
        'Cart Ref: 12345678 | Date: 26-11-2026 | Pamba Route | Pilgrims: 1 | Status: Payment Pending';

      const mockRow = {
        innerText: jest.fn().mockResolvedValue(pendingRowText),
        locator: jest.fn().mockReturnValue({ count: jest.fn().mockResolvedValue(0) }),
      };

      const mockPage: any = {
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockImplementation((sel: string) => {
          if (sel === 'table tbody tr') {
            return {
              count: jest.fn().mockResolvedValue(1),
              nth: jest.fn().mockReturnValue(mockRow),
            };
          }
          return { count: jest.fn().mockResolvedValue(0) };
        }),
        innerText: jest.fn().mockResolvedValue(pendingRowText),
      };

      const result = await SabarimalaPostLoginFlow.checkExistingBookingInHistory(mockPage, {
        requestedDate: '2026-11-26',
        requestedDateDisplay: '26-11-2026',
        cartId: '12345678',
      } as any);

      expect(result.found).toBe(false);
      expect(result.reconciliationRequired).toBe(true);
    });

    it('4. Valid official confirmed pass with matching date, CONFIRMED status, and 1 pilgrim → returns found: true', async () => {
      const confirmedRowText =
        'Pass No: IVQ2611261234567890 | Date: 26-11-2026 | Slot: 05:00 - 06:00 | Pilgrims: 1 Devotee | Status: Confirmed | Download Receipt';

      const mockRow = {
        innerText: jest.fn().mockResolvedValue(confirmedRowText),
        locator: jest.fn().mockReturnValue({ count: jest.fn().mockResolvedValue(1) }),
      };

      const mockPage: any = {
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockImplementation((sel: string) => {
          if (sel === 'table tbody tr') {
            return {
              count: jest.fn().mockResolvedValue(1),
              nth: jest.fn().mockReturnValue(mockRow),
            };
          }
          return { count: jest.fn().mockResolvedValue(0) };
        }),
        innerText: jest.fn().mockResolvedValue(confirmedRowText),
      };

      const result = await SabarimalaPostLoginFlow.checkExistingBookingInHistory(mockPage, {
        requestedDate: '2026-11-26',
        requestedDateDisplay: '26-11-2026',
      } as any);

      expect(result.found).toBe(true);
      expect(result.officialReference).toBe('IVQ2611261234567890');
      expect(result.status).toBe('CONFIRMED');
      expect(result.decision).toBe('CONFIRMED');
    });

    it('5. Unknown or unavailable history (empty table or page network failure) → RECONCILIATION_REQUIRED, never SUCCESS', async () => {
      const mockPage: any = {
        goto: jest.fn().mockRejectedValue(new Error('Network connection dropped')),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        locator: jest.fn().mockReturnValue({ count: jest.fn().mockResolvedValue(0) }),
        innerText: jest.fn().mockResolvedValue(''),
      };

      const result = await SabarimalaPostLoginFlow.checkExistingBookingInHistory(mockPage, {
        requestedDate: '2026-11-26',
      } as any);

      expect(result.found).toBe(false);
      expect(result.reconciliationRequired).toBe(true);
      expect(result.decision).toBe('RECONCILIATION_REQUIRED');
    });
  });

  describe('Part 2: End-to-end BookingWorker execution with false confirmation defense', () => {
    it('TA-10003 reproduction: Final confirmation throws and history has CANCELLED transaction with 0 pilgrims → NOT CONFIRMED, moves to RECONCILIATION_REQUIRED', async () => {
      // 1. Payment submission throws an error
      mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockRejectedValue(new Error('Gateway Timeout after submission'));

      // 2. Portal history returns CANCELLED with 0 pilgrims
      mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
        found: false,
        officialStatusFound: 'CANCELLED',
        pilgrimCountFound: 0,
        reconciliationRequired: true,
        decision: 'REJECTED_CANCELLED',
        decisionReason: 'Official portal transaction is CANCELLED (0 pilgrims). No pass created.',
      });

      const worker = new BookingWorker(mockApiClient);
      await worker.execute(sampleJob);

      // Invariant: completeJob was NEVER called!
      expect(mockApiClient.completeJob).not.toHaveBeenCalled();

      // Invariant: failJob was called with RECONCILIATION_REQUIRED and CONFIRMATION_UNVERIFIED
      expect(mockApiClient.failJob).toHaveBeenCalledTimes(1);
      const failPayload = mockApiClient.failJob.mock.calls[0][1];
      expect(failPayload.status).toBe('RECONCILIATION_REQUIRED');
      expect(failPayload.errorCode).toBe('CONFIRMATION_UNVERIFIED');
      expect(failPayload.errorMessage).toContain('CANCELLED (0 pilgrims)');
      expect(failPayload.taskIndex).toBe(1);

      // Invariant: Lifecycle state is RECONCILIATION_REQUIRED
      const lifecycle = BookingExecutionGuard.getLifecycleState('req-ta-10003');
      expect(lifecycle).toBe('RECONCILIATION_REQUIRED');
    });

    it('Confirmation dialog shows CANCELLED / FAILED status → NOT CONFIRMED, moves to RECONCILIATION_REQUIRED', async () => {
      // executePaymentProceedAndConfirm returns confirmed: false with message
      mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockResolvedValue({
        confirmed: false,
        reconciliationRequired: true,
        message: 'Official portal indicated transaction cancelled, failed, or 0 pilgrims.',
      });

      mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
        found: false,
        officialStatusFound: 'CANCELLED',
        reconciliationRequired: true,
      });

      const worker = new BookingWorker(mockApiClient);
      await worker.execute(sampleJob);

      expect(mockApiClient.completeJob).not.toHaveBeenCalled();
      expect(mockApiClient.failJob).toHaveBeenCalledWith(
        'job-ta-10003',
        expect.objectContaining({
          status: 'RECONCILIATION_REQUIRED',
          errorCode: 'CONFIRMATION_UNVERIFIED',
        }),
      );
    });

    it('Payment throws, but history genuinely finds a CONFIRMED pass with 1 pilgrim → reconciles successfully to CONFIRMED', async () => {
      mockAdapter.executePaymentProceedAndConfirm = jest.fn().mockRejectedValue(new Error('Gateway Timeout after submission'));

      // History check finds genuine confirmed pass
      mockAdapter.checkExistingBookingInHistory = jest.fn().mockResolvedValue({
        found: true,
        officialReference: 'IVQ261126888877776666',
        confirmedAt: '2026-11-26T05:30:00.000Z',
        status: 'CONFIRMED',
        pilgrimCountFound: 1,
        decision: 'CONFIRMED',
      });

      const worker = new BookingWorker(mockApiClient);
      await worker.execute(sampleJob);

      // Genuine confirmed pass reconciles cleanly
      expect(mockApiClient.completeJob).toHaveBeenCalledTimes(1);
      const completePayload: any = mockApiClient.completeJob.mock.calls[0][1];
      expect(completePayload.officialReference).toBe('IVQ261126888877776666');
      expect(completePayload.isFinalPilgrim).toBe(true);

      const lifecycle = BookingExecutionGuard.getLifecycleState('req-ta-10003');
      expect(lifecycle).toBe('BOOKING_CONFIRMED');
    });
  });
});
