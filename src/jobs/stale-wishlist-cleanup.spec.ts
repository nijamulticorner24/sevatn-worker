import { BookingWorker, BookingJobData } from './booking-worker';
import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { CredentialManager } from '../security/credential-manager';
import { BookingExecutionGuard } from '../security/execution-guard';
import { WishlistFlow, WishlistParsedItem } from '../sabarimala/flows/wishlist.flow';
import { PaymentReviewFlow } from '../sabarimala/flows/payment-review.flow';
import { BookingExecutionContext, VirtualQWorkflowError } from '../sabarimala/flows/types';

jest.mock('../sabarimala/sabarimala-adapter');
jest.mock('../security/credential-manager');

describe('Stale Unavailable Wishlist Item Handling & Drawer Recovery Suite', () => {
  let mockApiClient: jest.Mocked<ApiClient>;
  let mockAdapter: any;

  const sampleAccount = {
    id: 'acc-wishlist-01',
    username: '9876543210',
    encryptedPassword: 'enc:password',
    encryptionIv: 'iv:mock',
    encryptionTag: 'tag:mock',
  };

  const sampleJob: BookingJobData = {
    id: 'job-wishlist-001',
    bookingRequestId: 'req-wishlist-001',
    bookingCode: 'TA-WISH-2026',
    requestedDate: '2026-11-27',
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
    fencingToken: 'fnc_token_wishlist',
  };

  const sampleContext: BookingExecutionContext = {
    bookingId: 'req-wishlist-001',
    bookingCode: 'TA-WISH-2026',
    requestedDate: '2026-11-27',
    requestedDateDisplay: '27-11-2026',
    requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    selectedTimeSlot: '05:00 - 06:00',
    pilgrimCount: 1,
    reliefFund: 0,
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
  });

  describe('Part 1: Parsing and Identification of Wishlist Items', () => {
    it('correctly parses stale unavailable item (06-12-2026, 12:00–13:00, 1 pilgrim, Slot Unavailable)', () => {
      const rawText =
        'Date: 06-12-2026 | Route: Pamba - Marakkoottam - 4 Kms | Time: 12:00–13:00 | 1 Pilgrim | Slot Unavailable | Relief: ₹0';
      const parsed = WishlistFlow.parseWishlistItem(rawText, sampleContext, 0);

      expect(parsed.date).toBe('06-12-2026');
      expect(parsed.timeSlot).toBe('12:00-13:00');
      expect(parsed.pilgrimCount).toBe(1);
      expect(parsed.isUnavailable).toBe(true);
      expect(parsed.statusText).toBe('Slot Unavailable');
      expect(parsed.isCurrentAttemptMatch).toBe(false);
      expect(parsed.isStaleUnavailable).toBe(true);
    });

    it('correctly identifies valid unrelated item as NOT stale unavailable (do not clear)', () => {
      const rawText =
        'Date: 10-12-2026 | Route: Erumely Traditional Path | Time: 10:00 - 11:00 | 2 Pilgrims | Available | Relief: ₹0';
      const parsed = WishlistFlow.parseWishlistItem(rawText, sampleContext, 1);

      expect(parsed.date).toBe('10-12-2026');
      expect(parsed.isUnavailable).toBe(false);
      expect(parsed.statusText).toBe('Available');
      expect(parsed.isCurrentAttemptMatch).toBe(false);
      // Valid unrelated items must NOT be treated as stale unavailable
      expect(parsed.isStaleUnavailable).toBe(false);
    });

    it('correctly identifies matching current booking item (27-11-2026, 05:00-06:00, Available)', () => {
      const rawText =
        'Date: 27-11-2026 | Route: Pamba - Marakkoottam - 4 Kms | Time: 05:00 - 06:00 | 1 Pilgrim | Available | Relief: ₹0';
      const parsed = WishlistFlow.parseWishlistItem(rawText, sampleContext, 0);

      expect(parsed.date).toBe('27-11-2026');
      expect(parsed.timeSlot).toBe('05:00 - 06:00');
      expect(parsed.pilgrimCount).toBe(1);
      expect(parsed.isUnavailable).toBe(false);
      expect(parsed.isCurrentAttemptMatch).toBe(true);
      expect(parsed.isStaleUnavailable).toBe(false);
    });

    it('identifies matching current booking item marked Slot Unavailable as stale unavailable', () => {
      const rawText =
        'Date: 27-11-2026 | Route: Pamba - Marakkoottam - 4 Kms | Time: 05:00 - 06:00 | 1 Pilgrim | Slot Unavailable | Relief: ₹0';
      const parsed = WishlistFlow.parseWishlistItem(rawText, sampleContext, 0);

      expect(parsed.isUnavailable).toBe(true);
      expect(parsed.isStaleUnavailable).toBe(true);
    });
  });

  describe('Part 2: Selective Stale Unavailable Item Cleanup & Verification', () => {
    it('deletes only the exact stale unavailable item and preserves unrelated valid items', async () => {
      const staleItemText = 'Date: 06-12-2026 | Route: Pamba | Time: 12:00 - 13:00 | 1 Pilgrim | Slot Unavailable';
      const validItemText = 'Date: 10-12-2026 | Route: Pamba | Time: 08:00 - 09:00 | 2 Pilgrims | Available';

      let staleDeleted = false;
      const mockStaleDeleteBtn = {
        isVisible: jest.fn().mockResolvedValue(true),
        click: jest.fn().mockImplementation(async () => {
          staleDeleted = true;
        }),
      };

      const mockStaleLocator = {
        innerText: jest.fn().mockImplementation(async () => (staleDeleted ? '' : staleItemText)),
        locator: jest.fn().mockReturnValue({
          first: () => mockStaleDeleteBtn,
        }),
      };

      const mockValidLocator = {
        innerText: jest.fn().mockResolvedValue(validItemText),
        locator: jest.fn().mockReturnValue({
          first: () => ({ isVisible: jest.fn().mockResolvedValue(false), click: jest.fn() }),
        }),
      };

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('app-wishlist .item') || sel.includes('table tbody tr') || sel.includes('.wishlist-item')) {
            return {
              count: jest.fn().mockImplementation(async () => (staleDeleted ? 1 : 2)),
              nth: jest.fn((idx: number) => {
                if (staleDeleted) return mockValidLocator;
                return idx === 0 ? mockStaleLocator : mockValidLocator;
              }),
            };
          }
          if (sel.includes('mat-drawer') || sel.includes('.side-drawer') || sel.includes('app-wishlist')) {
            return {
              first: () => ({ isVisible: jest.fn().mockResolvedValue(true) }),
              count: jest.fn().mockResolvedValue(1),
            };
          }
          return {
            first: () => ({ isVisible: jest.fn().mockResolvedValue(false), click: jest.fn() }),
            count: jest.fn().mockResolvedValue(0),
          };
        }),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      const result = await WishlistFlow.inspectAndCleanStaleUnavailableWishlistItems(mockPage, sampleContext);

      expect(result.cleaned).toBe(true);
      expect(result.removedCount).toBe(1);
      expect(mockStaleDeleteBtn.click).toHaveBeenCalledTimes(1);
    });

    it('does not delete matching current booking item if it is not unavailable', async () => {
      const validCurrentText = 'Date: 27-11-2026 | Route: Pamba | Time: 05:00 - 06:00 | 1 Pilgrim | Available';
      const mockCurrentLocator = {
        innerText: jest.fn().mockResolvedValue(validCurrentText),
        locator: jest.fn().mockReturnValue({
          first: () => ({ isVisible: jest.fn().mockResolvedValue(true), click: jest.fn() }),
        }),
      };

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('app-wishlist .item') || sel.includes('table tbody tr') || sel.includes('.wishlist-item')) {
            return {
              count: jest.fn().mockResolvedValue(1),
              nth: jest.fn(() => mockCurrentLocator),
            };
          }
          if (sel.includes('mat-drawer') || sel.includes('.side-drawer') || sel.includes('app-wishlist')) {
            return {
              first: () => ({ isVisible: jest.fn().mockResolvedValue(true) }),
              count: jest.fn().mockResolvedValue(1),
            };
          }
          return {
            first: () => ({ isVisible: jest.fn().mockResolvedValue(false), click: jest.fn() }),
            count: jest.fn().mockResolvedValue(0),
          };
        }),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      const result = await WishlistFlow.inspectAndCleanStaleUnavailableWishlistItems(mockPage, sampleContext);

      expect(result.cleaned).toBe(false);
      expect(result.removedCount).toBe(0);
    });
  });

  describe('Part 3: Wishlist Drawer Visibility & Refresh Recovery', () => {
    it('Drawer appears immediately: verifies target booking on first turn without refresh', async () => {
      const currentBookingText =
        'Date: 27-11-2026 | Route: Pamba - Marakkoottam - 4 Kms | Time: 05:00 - 06:00 | 1 Pilgrim | Relief Fund: No';

      let isItemAdded = false;
      const mockAddBtn = {
        isVisible: jest.fn().mockResolvedValue(true),
        isDisabled: jest.fn().mockResolvedValue(false),
        scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockImplementation(async () => {
          isItemAdded = true;
        }),
      };

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('btn-addto') || sel.includes('Add to Wishlist')) {
            return { first: () => mockAddBtn };
          }
          if (sel.includes('.item') || sel.includes('wishlist-list') || sel.includes('table tbody tr') || sel.includes('.wishlist-item')) {
            return {
              count: jest.fn().mockImplementation(async () => (isItemAdded ? 1 : 0)),
              nth: jest.fn(() => ({
                innerText: jest.fn().mockResolvedValue(currentBookingText),
                locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
              })),
            };
          }
          if (sel.includes('mat-drawer') || sel.includes('.side-drawer') || sel.includes('app-wishlist')) {
            return {
              first: () => ({ isVisible: jest.fn().mockResolvedValue(true) }),
              count: jest.fn().mockResolvedValue(1),
              nth: jest.fn(() => ({
                innerText: jest.fn().mockResolvedValue(isItemAdded ? currentBookingText : ''),
                locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
              })),
            };
          }
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(false),
              waitFor: jest.fn().mockResolvedValue(undefined),
            }),
            count: jest.fn().mockResolvedValue(0),
            nth: jest.fn(() => ({
              innerText: jest.fn().mockResolvedValue(''),
              locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
            })),
          };
        }),
        reload: jest.fn().mockResolvedValue(undefined),
        waitForLoadState: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      const verified = await WishlistFlow.execute(mockPage, sampleContext);

      expect(verified).toBe(true);
      expect(mockAddBtn.click).toHaveBeenCalledTimes(1);
      // No reload should happen when drawer is visible immediately
      expect(mockPage.reload).not.toHaveBeenCalled();
    });

    it('Drawer does not appear immediately: recovers on Refresh Attempt 1 and verifies item', async () => {
      const currentBookingText =
        'Date: 27-11-2026 | Route: Pamba - Marakkoottam - 4 Kms | Time: 05:00 - 06:00 | 1 Pilgrim | Relief Fund: No';

      let reloadCount = 0;
      const mockAddBtn = {
        isVisible: jest.fn().mockResolvedValue(true),
        isDisabled: jest.fn().mockResolvedValue(false),
        scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockResolvedValue(undefined),
      };

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('btn-addto') || sel.includes('Add to Wishlist')) {
            return { first: () => mockAddBtn };
          }
          if (sel.includes('.item') || sel.includes('wishlist-list') || sel.includes('table tbody tr') || sel.includes('.wishlist-item')) {
            return {
              count: jest.fn().mockImplementation(async () => (reloadCount >= 1 ? 1 : 0)),
              nth: jest.fn(() => ({
                innerText: jest.fn().mockResolvedValue(currentBookingText),
                locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
              })),
            };
          }
          if (sel.includes('mat-drawer') || sel.includes('.side-drawer') || sel.includes('app-wishlist')) {
            return {
              // Visible only AFTER reload 1
              first: () => ({ isVisible: jest.fn().mockImplementation(async () => reloadCount >= 1) }),
              count: jest.fn().mockImplementation(async () => (reloadCount >= 1 ? 1 : 0)),
              nth: jest.fn(() => ({
                innerText: jest.fn().mockResolvedValue(currentBookingText),
                locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
              })),
            };
          }
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(false),
              waitFor: jest.fn().mockResolvedValue(undefined),
              click: jest.fn().mockResolvedValue(undefined),
            }),
            count: jest.fn().mockResolvedValue(0),
            nth: jest.fn(() => ({
              innerText: jest.fn().mockResolvedValue(''),
              locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
            })),
          };
        }),
        reload: jest.fn().mockImplementation(async () => {
          reloadCount++;
        }),
        waitForLoadState: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      const verified = await WishlistFlow.execute(mockPage, sampleContext);

      expect(verified).toBe(true);
      // Reloaded once to recover drawer
      expect(mockPage.reload).toHaveBeenCalledTimes(1);
      // Did NOT submit Add to Wishlist twice
      expect(mockAddBtn.click).toHaveBeenCalledTimes(1);
    });

    it('Drawer still not verified after 2 full refreshes: fails safely with WISHLIST_DRAWER_NOT_FOUND', async () => {
      const mockAddBtn = {
        isVisible: jest.fn().mockResolvedValue(true),
        isDisabled: jest.fn().mockResolvedValue(false),
        scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockResolvedValue(undefined),
      };

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('btn-addto') || sel.includes('Add to Wishlist')) {
            return { first: () => mockAddBtn };
          }
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(false),
              waitFor: jest.fn().mockResolvedValue(undefined),
              click: jest.fn().mockResolvedValue(undefined),
            }),
            count: jest.fn().mockResolvedValue(0),
          };
        }),
        reload: jest.fn().mockResolvedValue(undefined),
        waitForLoadState: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      await expect(WishlistFlow.execute(mockPage, sampleContext)).rejects.toThrow(
        /WISHLIST_DRAWER_NOT_FOUND/,
      );

      // Reloaded exactly twice before safely giving up
      expect(mockPage.reload).toHaveBeenCalledTimes(2);
      // Never clicked Add to Wishlist again during recovery
      expect(mockAddBtn.click).toHaveBeenCalledTimes(1);
    });
  });

  describe('Part 4: Pre-Checkout Verification (verifyWishlistBeforeCheckout)', () => {
    it('blocks checkout if a stale unavailable item is still present in Wishlist', async () => {
      const staleItemText = 'Date: 06-12-2026 | Route: Pamba | Time: 12:00 - 13:00 | 1 Pilgrim | Slot Unavailable';
      const currentItemText = 'Date: 27-11-2026 | Route: Pamba | Time: 05:00 - 06:00 | 1 Pilgrim | Available';

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('table tbody tr') || sel.includes('wishlist-list') || sel.includes('.item')) {
            return {
              count: jest.fn().mockResolvedValue(2),
              nth: jest.fn((idx: number) => ({
                innerText: jest.fn().mockResolvedValue(idx === 0 ? staleItemText : currentItemText),
                locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
              })),
            };
          }
          return {
            first: () => ({ isVisible: jest.fn().mockResolvedValue(false), click: jest.fn() }),
            count: jest.fn().mockResolvedValue(0),
          };
        }),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      await expect(WishlistFlow.verifyWishlistBeforeCheckout(mockPage, sampleContext)).rejects.toThrow(
        /WISHLIST_STALE_ITEM_STILL_PRESENT/,
      );
    });

    it('blocks checkout if multiple duplicate items exist for the current booking', async () => {
      const currentItemText = 'Date: 27-11-2026 | Route: Pamba | Time: 05:00 - 06:00 | 1 Pilgrim | Available';

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('table tbody tr') || sel.includes('wishlist-list') || sel.includes('.item')) {
            return {
              count: jest.fn().mockResolvedValue(2),
              nth: jest.fn(() => ({
                innerText: jest.fn().mockResolvedValue(currentItemText),
                locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
              })),
            };
          }
          return {
            first: () => ({ isVisible: jest.fn().mockResolvedValue(false), click: jest.fn() }),
            count: jest.fn().mockResolvedValue(0),
          };
        }),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      await expect(WishlistFlow.verifyWishlistBeforeCheckout(mockPage, sampleContext)).rejects.toThrow(
        /WISHLIST_DUPLICATE_ITEM_DETECTED/,
      );
    });

    it('passes pre-checkout verification when exactly one clean current item is present', async () => {
      const currentItemText = 'Date: 27-11-2026 | Route: Pamba | Time: 05:00 - 06:00 | 1 Pilgrim | Available';

      const mockPage: any = {
        locator: jest.fn((sel: string) => {
          if (sel.includes('table tbody tr') || sel.includes('wishlist-list') || sel.includes('.item')) {
            return {
              count: jest.fn().mockResolvedValue(1),
              nth: jest.fn(() => ({
                innerText: jest.fn().mockResolvedValue(currentItemText),
                locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
              })),
            };
          }
          return {
            first: () => ({ isVisible: jest.fn().mockResolvedValue(false), click: jest.fn() }),
            count: jest.fn().mockResolvedValue(0),
          };
        }),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      };

      const result = await WishlistFlow.verifyWishlistBeforeCheckout(mockPage, sampleContext);
      expect(result).toBe(true);
    });
  });

  describe('Part 5: End-to-End BookingWorker with Post-Login Cleanup', () => {
    it('inspects and cleans stale unavailable Wishlist items post-login, then books single devotee', async () => {
      mockAdapter = {
        init: jest.fn().mockResolvedValue(undefined),
        openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
        checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true, state: 'AVAILABLE' }),
        openLogin: jest.fn().mockResolvedValue(true),
        login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
        handlePostLoginPopup: jest.fn().mockResolvedValue(true),
        inspectAndCleanStaleUnavailableWishlistItems: jest.fn().mockResolvedValue({ cleaned: true, removedCount: 1 }),
        verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
        selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '05:00 - 06:00' }),
        selectBookingType: jest.fn().mockResolvedValue(true),
        verifyDateTimePreserved: jest.fn().mockReturnValue(true),
        selectSingleSavedPilgrim: jest.fn().mockResolvedValue({
          success: true,
          selectedPilgrim: { fullName: 'Devotee One', identityFingerprint: 'fp_devotee_1' },
        }),
        populateNomineeDetails: jest.fn().mockResolvedValue(true),
        handlePrasadamDetails: jest.fn().mockResolvedValue(true),
        selectReliefFundNo: jest.fn().mockResolvedValue(true),
        addToWishlistAndVerify: jest.fn().mockResolvedValue(true),
        proceedToPaymentGateway: jest.fn().mockResolvedValue(true),
        verifyPaymentSummary: jest.fn().mockResolvedValue(true),
        executePaymentProceedAndConfirm: jest.fn().mockResolvedValue({
          confirmed: true,
          officialReference: 'IVQ20261127050012',
          confirmedAt: new Date().toISOString(),
          confirmationEvidence: { verified: true },
        }),
        logout: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

      const worker = new BookingWorker(mockApiClient);
      await worker.execute(sampleJob);

      // Verify post-login cleanup was called
      expect(mockAdapter.inspectAndCleanStaleUnavailableWishlistItems).toHaveBeenCalledTimes(1);

      // Verify single devotee completed successfully
      expect(mockApiClient.completeJob).toHaveBeenCalledWith(
        'job-wishlist-001',
        expect.objectContaining({
          officialReference: 'IVQ20261127050012',
          isFinalPilgrim: true,
        }),
      );
    });

    it('WISHLIST_DRAWER_NOT_FOUND returns to queue safely as TEMPORARY_SLOT_LOST', async () => {
      mockAdapter = {
        init: jest.fn().mockResolvedValue(undefined),
        openDarshanAvailability: jest.fn().mockResolvedValue({ success: true }),
        checkRequestedDateAvailability: jest.fn().mockResolvedValue({ available: true, state: 'AVAILABLE' }),
        openLogin: jest.fn().mockResolvedValue(true),
        login: jest.fn().mockResolvedValue({ status: 'LOGIN_SUCCESS' }),
        handlePostLoginPopup: jest.fn().mockResolvedValue(true),
        inspectAndCleanStaleUnavailableWishlistItems: jest.fn().mockResolvedValue({ cleaned: false, removedCount: 0 }),
        verifyCarriedDateAndRoute: jest.fn().mockResolvedValue(true),
        selectPostLoginSlotWithRefreshFallback: jest.fn().mockResolvedValue({ success: true, selectedSlot: '05:00 - 06:00' }),
        selectBookingType: jest.fn().mockResolvedValue(true),
        verifyDateTimePreserved: jest.fn().mockReturnValue(true),
        selectSingleSavedPilgrim: jest.fn().mockResolvedValue({
          success: true,
          selectedPilgrim: { fullName: 'Devotee One', identityFingerprint: 'fp_devotee_1' },
        }),
        populateNomineeDetails: jest.fn().mockResolvedValue(true),
        handlePrasadamDetails: jest.fn().mockResolvedValue(true),
        selectReliefFundNo: jest.fn().mockResolvedValue(true),
        addToWishlistAndVerify: jest.fn().mockRejectedValue({
          errorCode: 'WISHLIST_DRAWER_NOT_FOUND',
          message: 'Wishlist drawer did not appear or target booking could not be verified after 2 full page refreshes',
        }),
        logout: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (PlaywrightSabarimalaAdapter as jest.Mock).mockImplementation(() => mockAdapter);

      const worker = new BookingWorker(mockApiClient);
      await worker.execute(sampleJob);

      // Verify job was NOT marked complete
      expect(mockApiClient.completeJob).not.toHaveBeenCalled();

      // Verify failed safely with TEMPORARY_SLOT_LOST to return to queue
      expect(mockApiClient.failJob).toHaveBeenCalledWith(
        'job-wishlist-001',
        expect.objectContaining({
          status: 'TEMPORARY_SLOT_LOST',
          errorCode: 'WISHLIST_DRAWER_NOT_FOUND',
        }),
      );
    });
  });
});
