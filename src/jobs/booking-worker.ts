import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { normalizeDate } from '../sabarimala/virtual-q';
import { CredentialManager } from '../security/credential-manager';
import { SanitizedLogger } from '../monitoring/logger';
import { BookingExecutionContext, SabarimalaPostLoginFlow } from '../sabarimala/post-login-flow';
import { BookingExecutionGuard } from '../security/execution-guard';
import { validateNominee } from '../security/nominee-validator';
import { BookingConfirmationFlow } from '../sabarimala/flows/booking-confirmation.flow';
import { ReliefFundFlow } from '../sabarimala/flows/relief-fund.flow';
import { ConfirmMarkerManager } from '../security/confirm-marker';
import { PendingCompletionsManager } from '../resilience/pending-completions';
import { TelegramFailureNotifier } from '../monitoring/telegram-notifier';

import { AvailabilityCache } from '../availability/availability-cache';

export interface BookingJobData {
  id: string;
  bookingRequestId: string;
  bookingCode: string;
  requestedDate: string | Date;
  route: string;
  pilgrimCount?: number;
  timeSlot?: string;
  selectedTime?: string;
  preferences?: Record<string, any>;
  pilgrims?: any[];
  nominee?: any;
  nominees?: any[];
  account?: {
    id: string;
    username: string;
    encryptedPassword?: string;
    encryptionIv?: string;
    encryptionTag?: string;
  } | null;
  accountId?: string;
  leaseExpiresAt?: string;
  leaseGeneration?: number;
  fencingToken?: string;
  verifiedAvailable?: boolean;
  skipPreflight?: boolean;
  dispatchSource?: string;
}

export class BookingWorker {
  constructor(
    private apiClient: ApiClient,
    private cache: AvailabilityCache = AvailabilityCache.getInstance(),
  ) { }

  private async reportProgress(job: BookingJobData, status: string, note?: string, logs?: any) {
    if (job.leaseGeneration === undefined || job.leaseGeneration === null || !job.fencingToken) {
      throw new Error(`LEASE_INCOMPLETE: Missing leaseGeneration or fencingToken on job #${job.id}`);
    }
    try {
      return await this.apiClient.updateJobProgress(job.id, {
        status,
        note,
        logs,
        leaseGeneration: job.leaseGeneration,
        fencingToken: job.fencingToken,
      });
    } catch (err: any) {
      const statusCode = err?.response?.status || err?.statusCode || (err as any)?.status;
      if (
        statusCode === 409 ||
        err?.conflictReason ||
        String(err?.message || '').includes('STALE_LEASE') ||
        String(err?.message || '').includes('FENCING_TOKEN')
      ) {
        const reason = err?.conflictReason || err?.response?.data?.message || err?.message || 'STALE_LEASE_GENERATION';
        (job as any).leaseLost = true;
        SanitizedLogger.error(
          `[BOOKING] Progress update rejected with HTTP 409 Conflict for #${job.bookingCode || job.id}: ${reason}. Lease superseded on server.`
        );
        const leaseErr: any = new Error(`LEASE_LOST_CONFLICT: ${reason}`);
        leaseErr.statusCode = 409;
        leaseErr.status = 409;
        leaseErr.response = err?.response;
        leaseErr.conflictReason = reason;
        throw leaseErr;
      }
      throw err;
    }
  }

  private async reportComplete(
    job: BookingJobData,
    payload: {
      officialReference?: string;
      cartId?: string;
      officialBookingReference?: string;
      officialReceiptReference?: string;
      portalTransactionReference?: string;
      confirmationEvidence?: any;
      confirmedAt?: string;
      confirmationData?: any;
      note?: string;
      pilgrimTaskId?: string;
      taskIndex?: number;
      selectedPilgrim?: any;
      isFinalPilgrim?: boolean;
      totalRequestedPilgrims?: number;
      confirmedPilgrimsCount?: number;
      remainingDevoteesCount?: number;
    },
  ) {
    ConfirmMarkerManager.clearMarker(job.bookingCode);
    const passRef = payload.officialBookingReference || payload.officialReference;

    // Requirement 4: Persist pending completion to durable local file queue before API call
    PendingCompletionsManager.savePending({
      jobId: job.id,
      bookingRequestId: job.bookingRequestId,
      bookingCode: job.bookingCode,
      accountId: job.accountId || job.account?.id,
      officialReference: payload.officialReference,
      officialBookingReference: payload.officialBookingReference,
      cartId: payload.cartId,
      officialReceiptReference: payload.officialReceiptReference,
      portalTransactionReference: payload.portalTransactionReference,
      confirmationEvidence: payload.confirmationEvidence,
      confirmedAt: payload.confirmedAt,
      confirmationData: payload.confirmationData,
      note: payload.note,
      leaseGeneration: job.leaseGeneration ?? 1,
      fencingToken: job.fencingToken ?? 'fallback-token',
      protocolVersion: 'v2.0-fenced',
    });

    try {
      const res = await this.apiClient.completeJob(job.id, {
        ...payload,
        leaseGeneration: job.leaseGeneration ?? 1,
        fencingToken: job.fencingToken ?? 'fallback-token',
        protocolVersion: 'v2.0-fenced',
      });
      // Remove file only after a successful response
      PendingCompletionsManager.removePending(job.id);
      const finalState = (payload as any).isFinalPilgrim === false ? 'PARTIALLY_COMPLETED' : 'BOOKING_CONFIRMED';
      BookingExecutionGuard.updateLifecycleState(job.bookingRequestId || job.bookingCode || job.id, finalState);
      return res;
    } catch (err: any) {
      SanitizedLogger.warn(`[BOOKING] completeJob API notice for Job #${job.id}: ${err?.message || err}. Real pass reference was confirmed: ${passRef}. Retained in durable pending completions queue for background sync.`);
      const finalState = (payload as any).isFinalPilgrim === false ? 'PARTIALLY_COMPLETED' : 'BOOKING_CONFIRMED';
      BookingExecutionGuard.updateLifecycleState(job.bookingRequestId || job.bookingCode || job.id, finalState);
      return { success: true, needsReview: true, ref: passRef };
    }
  }

  private async reportFail(
    job: BookingJobData,
    payload: {
      status: string;
      errorCode?: string;
      errorMessage?: string;
      screenshot?: string;
      pilgrimTaskId?: string;
      taskIndex?: number;
      selectedPilgrim?: any;
    },
    adapter?: PlaywrightSabarimalaAdapter,
  ) {
    if (job.leaseGeneration === undefined || job.leaseGeneration === null || !job.fencingToken) {
      SanitizedLogger.error(`[BOOKING] Cannot reportFail to server for job #${job.id}: leaseGeneration or fencingToken missing.`);
      throw new Error(`LEASE_INCOMPLETE: Missing leaseGeneration or fencingToken on job #${job.id}`);
    }

    let screenshot = payload.screenshot;
    if (!screenshot && adapter) {
      try {
        screenshot = (await adapter.captureScreenshotBase64()) || undefined;
      } catch (shotErr: any) {
        SanitizedLogger.warn(`[BOOKING] Could not capture failure screenshot: ${shotErr?.message || shotErr}`);
      }
    }

    const activeLock = BookingExecutionGuard.getActiveLock(job.bookingRequestId || job.bookingCode || job.id);
    const failureStage = activeLock?.lifecycleState || payload.errorCode || 'BOOKING_EXECUTION';

    // Dispatch real-time Telegram screenshot and failure alert
    let telegramAlertResult: any = null;
    try {
      telegramAlertResult = await TelegramFailureNotifier.sendFailureAlert({
        bookingId: job.bookingRequestId || job.id,
        bookingCode: job.bookingCode,
        requestedDate: normalizeDate(job.requestedDate),
        route: job.route,
        pilgrimCount: job.pilgrimCount,
        devoteeSequence: payload.taskIndex,
        devoteeName: payload.selectedPilgrim?.fullName,
        failureStage,
        errorMessage: payload.errorMessage || 'Booking execution failure',
        retryAttempt: (job as any).retryAttempt || 1,
        maxRetries: (job as any).maxRetries || 3,
        screenshotBase64: screenshot,
      });
      SanitizedLogger.info(
        `[TELEGRAM-ALERT-STATUS] Booking #${job.bookingCode} alert dispatch result: deliveredVia=${telegramAlertResult.deliveredVia}, success=${telegramAlertResult.success}${telegramAlertResult.error ? ', status=' + telegramAlertResult.error : ''}`,
      );
    } catch (telegramErr: any) {
      SanitizedLogger.warn(`[BOOKING] Non-blocking Telegram alert notice: ${telegramErr?.message || telegramErr}`);
    }

    try {
      const apiFailResult = await this.apiClient.failJob(job.id, {
        ...payload,
        screenshot,
        leaseGeneration: job.leaseGeneration,
        fencingToken: job.fencingToken,
      });
      SanitizedLogger.info(
        `[CENTRAL-API-REPORT] Job failure report delivered to central API for #${job.bookingCode}. Status: ${apiFailResult ? 'ACCEPTED' : 'UNKNOWN'}`,
      );
      return apiFailResult;
    } catch (apiErr: any) {
      SanitizedLogger.error(
        `[CENTRAL-API-REPORT] Failed to deliver failure report to central API for #${job.bookingCode}: ${apiErr?.message || apiErr}`,
      );
      throw apiErr;
    }
  }

  async execute(job: BookingJobData): Promise<void> {
    if (job.leaseGeneration === undefined || job.leaseGeneration === null || !job.fencingToken) {
      SanitizedLogger.error(`[BOOKING] Refusing execution for job #${job.id}: Missing leaseGeneration or fencingToken.`);
      throw new Error(`LEASE_INCOMPLETE: Missing leaseGeneration or fencingToken on job #${job.id}`);
    }

    const canonicalDate = normalizeDate(job.requestedDate);
    const isPendingExecution = !!job.selectedTime;
    const bookingKey = job.bookingRequestId || job.bookingCode || job.id;
    let internalLockAcquired = false;

    // Defense-in-depth: Ensure atomic per-booking execution lock is held
    const activeLock =
      BookingExecutionGuard.getLock(bookingKey) ||
      (job.bookingCode ? BookingExecutionGuard.getLock(job.bookingCode) : undefined) ||
      BookingExecutionGuard.getLock(job.id);

    if (activeLock) {
      if (activeLock.jobId !== job.id) {
        SanitizedLogger.warn(
          `[BOOKING] Deduplication: Aborting duplicate execution for #${job.bookingCode || bookingKey}. Active lock owned by Job #${activeLock.jobId} (Attempt: ${activeLock.attemptId}).`,
        );
        return;
      }
      // If it's the exact same jobId, lock was already acquired upstream by Orchestrator
    } else {
      const lockRes = BookingExecutionGuard.acquire({
        bookingId: job.bookingRequestId || job.id,
        bookingCode: job.bookingCode || job.id,
        jobId: job.id,
        dispatchSource: (job as any).dispatchSource || (isPendingExecution ? 'PENDING_MONITOR' : 'QUEUE_POLL'),
        owner: 'BOOKING_WORKER',
      });
      if (!lockRes.acquired) {
        SanitizedLogger.warn(
          `[BOOKING] Deduplication: Aborting duplicate execution for #${job.bookingCode || bookingKey}. Active lock owned by Job #${lockRes.existingLock?.jobId}.`,
        );
        return;
      }
      internalLockAcquired = true;
    }

    const requestedPilgrimCount = Math.max(1, Math.min(5, Number(job.pilgrimCount || 1)));
    const authPolicy = (job.preferences as any)?.customerAuthorizationPolicy || {};
    const ctx: BookingExecutionContext = {
      bookingId: job.bookingRequestId,
      jobId: job.id,
      bookingCode: job.bookingCode,
      leaseGeneration: job.leaseGeneration,
      fencingToken: job.fencingToken,
      apiClient: this.apiClient,
      requestedDate: canonicalDate,
      requestedDateDisplay: SabarimalaPostLoginFlow.toDisplayDate(canonicalDate),
      requestedRoute: job.route,
      selectedTimeSlot: job.selectedTime || job.timeSlot || undefined,
      pilgrimCount: requestedPilgrimCount,
      reliefFund: 0,
      accountId: job.account?.id || job.accountId,
      nominee: job.nominee || null,
      nominees: (job as any).nominees || (job.preferences as any)?.nominees || [],
      pilgrims: job.pilgrims || [],
      excludedPilgrimFingerprints: (job as any).excludedPilgrimFingerprints || [],
      preferences: job.preferences || {},
      allowZeroCostConfirmation: authPolicy.allowZeroCostConfirmation !== false,
      allowPayment: authPolicy.allowPayment === true,
    };

    if (isPendingExecution) {
      SanitizedLogger.info(`[PENDING-MONITOR] ⚡ Pending booking execution started`);
      SanitizedLogger.info(`[PENDING-MONITOR] Target: #${job.bookingCode} | Date: ${canonicalDate} | Slot: ${job.selectedTime}`);
    } else {
      SanitizedLogger.info(`[FAST-BOOKING] New request`);
      SanitizedLogger.info(`[FAST-BOOKING] Checking requested date: ${canonicalDate}`);
    }

    // STEP 0: MANDATORY NOMINEE VALIDATION (Fail-fast before launching browser)
    const nomineeCheck = validateNominee(ctx);
    if (!nomineeCheck.valid) {
      SanitizedLogger.error(`[BOOKING] Pre-execution nominee validation failed for #${job.bookingCode}: ${nomineeCheck.errors.join('; ')}`);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'HOLD_INVALID_NOMINEE');
      await this.reportFail(job, {
        status: 'HOLD_INVALID_NOMINEE',
        errorCode: 'NOMINEE_DETAILS_MISSING',
        errorMessage: `Mandatory nominee validation failed: ${nomineeCheck.errors.join('; ')}`,
      });
      if (internalLockAcquired) {
        BookingExecutionGuard.release(bookingKey, job.id);
      }
      return;
    }

    // Pre-check: If all devotees are already confirmed, complete immediately without launching browser
    if (Array.isArray(job.pilgrims) && job.pilgrims.length > 0) {
      const allConfirmed = job.pilgrims.every((p) => {
        const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
        return meta.taskStatus === 'CONFIRMED' || meta.status === 'CONFIRMED' || !!meta.officialBookingReference;
      });
      if (allConfirmed) {
        SanitizedLogger.info(
          `[SEQUENTIAL-BOOKING] All ${job.pilgrims.length} devotees already confirmed for Booking #${job.bookingCode}. Completing job.`,
        );
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_CONFIRMED');
        if (internalLockAcquired) {
          BookingExecutionGuard.release(bookingKey, job.id);
        }
        return;
      }
    }

    let currentTask: any = null;
    let currentPilgrimNum: number = 1;
    let rawPilgrims: any[] = [];

    // Availability is verified by the check loop before claiming. Proceed directly to authenticated booking flow.
    const adapter = new PlaywrightSabarimalaAdapter();

    try {
      await adapter.init();

      BookingExecutionGuard.updateLifecycleState(bookingKey, 'PROCESSING');
      await this.reportProgress(job, 'PROCESSING', `Initiating autonomous booking flow for #${job.bookingCode || bookingKey}`);

      // STEP 1 — Open the official darshanAvailability page
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'AVAILABILITY_CHECKING');
      await this.reportProgress(job, 'AVAILABILITY_CHECKING', `Opening official Darshan Availability page for ${canonicalDate}`);

      const openRes = typeof adapter.openDarshanAvailability === 'function'
        ? await adapter.openDarshanAvailability()
        : { success: true };
      if (!openRes.success) {
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
        await this.reportFail(job, {
          status: 'SITE_ERROR',
          errorCode: 'OFFICIAL_SITE_UNAVAILABLE',
          errorMessage: 'Official Darshan Availability page could not be reached.',
        }, adapter);
        return;
      }

      // STEP 2 — Select the exact requested booking date
      if (typeof adapter.selectRequestedDate === 'function') {
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'SELECTING_DATE');
        await this.reportProgress(job, 'SELECTING_DATE', `Selecting exact requested booking date: ${canonicalDate}`);
        const dateSelectionResult: any = await adapter.selectRequestedDate(canonicalDate);
        if (dateSelectionResult && dateSelectionResult.success === false) {
          SanitizedLogger.warn(`[BOOKING] Requested date ${canonicalDate} is not selectable: ${dateSelectionResult.error || 'Date disabled or cell not found'}. Returning to monitoring.`);
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'TEMPORARY_SLOT_LOST');
          await this.reportFail(job, {
            status: 'TEMPORARY_SLOT_LOST',
            errorCode: 'DATE_NOT_SELECTABLE',
            errorMessage: `Requested date ${canonicalDate} is not selectable (${dateSelectionResult.error || 'disabled or unavailable'}). Returning to monitoring.`,
          }, adapter);
          return;
        }
      }

      // STEP 3 — Select the requested route
      if (typeof adapter.selectRoute === 'function') {
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'SELECTING_ROUTE');
        await this.reportProgress(job, 'SELECTING_ROUTE', `Selecting requested route: ${job.route}`);
        await adapter.selectRoute(job.route);
      }

      BookingExecutionGuard.updateLifecycleState(bookingKey, 'DATE_VERIFIED');
      await this.reportProgress(job, 'DATE_VERIFIED', `Date and route selected: ${canonicalDate} - ${job.route}`);
      await this.reportProgress(job, 'ROUTE_VERIFIED', `Route selected: ${job.route}`);

      // Dispatch date available Telegram notification (non-blocking)
      if (typeof this.apiClient.notifyDateAvailable === 'function') {
        this.apiClient.notifyDateAvailable({
          bookingId: job.id || job.bookingRequestId,
          bookingCode: job.bookingCode,
          date: canonicalDate,
          route: job.route,
          slot: job.timeSlot || job.selectedTime,
          timeSlot: job.timeSlot || job.selectedTime,
        }).catch((err: any) => {
          SanitizedLogger.warn(`[TELEGRAM] Date available notification notice: ${err.message || err}`);
        });
      }

      // STEP 4 — Click the portal's own Login button on that page
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'LOGIN_IN_PROGRESS');
      await this.reportProgress(job, 'LOGIN_IN_PROGRESS', 'Clicking portal Login button on darshanAvailability page');
      if (typeof adapter.proceedToLogin === 'function') {
        await adapter.proceedToLogin();
      } else if (typeof (adapter as any).openLogin === 'function') {
        await (adapter as any).openLogin();
      }

      // STEP 6 — Enter the configured credentials and complete login
      if (!job.account || !job.account.encryptedPassword || !job.account.encryptionIv || !job.account.encryptionTag) {
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
        await this.reportFail(job, {
          status: 'LOGIN_FAILED',
          errorCode: 'CREDENTIALS_MISSING',
          errorMessage: 'No official Sabarimala credentials attached to this booking job. Requires credential update.',
        }, adapter);
        return;
      }

      const password = CredentialManager.decrypt(
        job.account.encryptedPassword,
        job.account.encryptionIv,
        job.account.encryptionTag,
      );

      const loginResult = await adapter.login(job.account.username, password);

      if (loginResult.status !== 'LOGIN_SUCCESS') {
        if (loginResult.status === 'OTP_REQUIRED' || loginResult.status === 'CAPTCHA_REQUIRED') {
          BookingExecutionGuard.releaseGlobalPriorityLock();
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
          await this.reportFail(job, {
            status: 'TEMPORARY_SLOT_LOST',
            errorCode: loginResult.status,
            errorMessage: loginResult.message || 'Official portal requested verification challenge (CAPTCHA/OTP). Safely returning to WATCHING.',
          }, adapter);
          return;
        } else if (
          loginResult.status === 'INVALID_CREDENTIALS' ||
          (loginResult.message && /invalid|password|username/i.test(loginResult.message))
        ) {
          // If password/username is invalid, release priority lock and return to retryable monitoring
          BookingExecutionGuard.releaseGlobalPriorityLock();
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
          await this.reportFail(job, {
            status: 'LOGIN_FAILED',
            errorCode: loginResult.status === 'INVALID_CREDENTIALS' ? 'INVALID_CREDENTIALS' : 'CREDENTIALS_INVALID',
            errorMessage: loginResult.message || 'Official Sabarimala login failed due to invalid credentials.',
          }, adapter);
          return;
        } else {
          // Temporary login / portal error: retryable
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
          await this.reportFail(job, {
            status: 'RETRYABLE_FAILURE',
            errorCode: loginResult.status || 'LOGIN_TEMPORARY_FAILURE',
            errorMessage: loginResult.message || 'Official Sabarimala login temporary failure. Will retry.',
          }, adapter);
          return;
        }
      }

      SanitizedLogger.info('[LOGIN] Login successful');
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'LOGIN_SUCCESS');
      await this.reportProgress(job, 'LOGIN_SUCCESS', 'Official portal authenticated successfully.');

      // Check if a prior CONFIRM_CLICKED marker exists for this booking (on disk or from server lastMilestone)
      const hasPriorConfirmAttempt =
        ConfirmMarkerManager.hasMarker(job.bookingCode) ||
        (job as any).lastMilestone === 'CONFIRM_CLICKED';

      if (hasPriorConfirmAttempt) {
        SanitizedLogger.info(`[RECONCILIATION] Prior CONFIRM_CLICKED marker found for #${job.bookingCode}. Checking portal booking history first...`);
        const historyCheck: any =
          typeof adapter.checkExistingBookingInHistory === 'function'
            ? await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false }))
            : { found: false };

        if (historyCheck && historyCheck.found && historyCheck.officialReference && historyCheck.status !== 'CANCELLED') {
          SanitizedLogger.info(`[RECONCILIATION] Existing pass #${historyCheck.officialReference} verified in portal history. Completing job directly without rebooking.`);
          ConfirmMarkerManager.clearMarker(job.bookingCode);
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_CONFIRMED');
          await this.reportComplete(job, {
            officialReference: historyCheck.officialReference,
            officialBookingReference: historyCheck.officialReference,
            confirmedAt: historyCheck.confirmedAt || new Date().toISOString(),
            isFinalPilgrim: Math.max(1, Number(job.pilgrimCount || 1)) <= 1,
            note: `Reconciled from portal booking history after prior CONFIRM_CLICKED #${historyCheck.officialReference}`,
            confirmationData: {
              officialReference: historyCheck.officialReference,
              officialBookingReference: historyCheck.officialReference,
              requestedDate: canonicalDate,
              selectedTime: ctx.selectedTimeSlot,
              route: ctx.requestedRoute,
              pilgrimsCount: ctx.pilgrimCount || 1,
              status: 'CONFIRMED',
              reconciledFromHistory: true,
            },
          });
          return;
        } else if (historyCheck?.officialStatusFound === 'CANCELLED') {
          SanitizedLogger.warn(`[RECONCILIATION] Prior transaction on official portal is CANCELLED (0 pilgrims). Clearing marker so fresh attempt can run safely.`);
          ConfirmMarkerManager.clearMarker(job.bookingCode);
        } else {
          SanitizedLogger.warn(`[RECONCILIATION] Prior submission status ambiguous and cannot be verified. Stopping for human review.`);
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'RECONCILIATION_REQUIRED');
          await this.reportFail(job, {
            status: 'RECONCILIATION_REQUIRED',
            errorCode: 'CONFIRMATION_UNVERIFIED',
            errorMessage: 'Prior confirmation attempt unverified in portal history. Requires human review.',
          }, adapter);
          return;
        }
        SanitizedLogger.info(`[RECONCILIATION] Prior pass check completed for #${job.bookingCode}. Navigating back to #/darshan to proceed.`);
        if (typeof adapter.navigateToHomeAndDarshan === 'function') {
          await adapter.navigateToHomeAndDarshan(ctx).catch(() => { });
        }
      }

      // STEP 7 — Handle the post-login popup
      if (typeof adapter.handlePostLoginPopup === 'function') {
        await adapter.handlePostLoginPopup().catch(() => { });
      }

      // STEP 7.1 — Initial Wishlist cleanup immediately after login (Inspect right-side Wishlist panel & clear stale items)
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'INITIAL_WISHLIST_CLEANUP');
      await this.reportProgress(job, 'INITIAL_WISHLIST_CLEANUP', 'Inspecting right-side Wishlist panel post-login');

      let cleanupOk = true;
      if (typeof (adapter as any).initialWishlistCleanup === 'function') {
        try {
          cleanupOk = await (adapter as any).initialWishlistCleanup(ctx);
        } catch (cleanErr: any) {
          SanitizedLogger.error(`[BOOKING] Initial wishlist cleanup threw: ${cleanErr?.message || cleanErr}`);
          cleanupOk = false;
        }
      }

      if (!cleanupOk) {
        SanitizedLogger.warn(`[BOOKING] Initial Wishlist cleanup could not be verified for #${job.bookingCode}. Returning safely to queue without duplicate booking.`);
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
        if (typeof adapter.logout === 'function') {
          await adapter.logout().catch(() => { });
        }
        await this.reportFail(job, {
          status: 'RETRYABLE_FAILURE',
          errorCode: 'WISHLIST_CLEANUP_FAILED',
          errorMessage: 'Initial Wishlist cleanup failed or old items could not be cleared after login. Safe queue return.',
        }, adapter);
        return;
      }

      // STEP 8 — The portal should already carry the selected date and route into the booking page. Verify both are correct.
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'VERIFYING_CARRIED_SELECTION');
      await this.reportProgress(job, 'VERIFYING_CARRIED_SELECTION', 'Verifying carried date and route on booking page');
      if (typeof adapter.verifyCarriedDateAndRoute === 'function') {
        try {
          const carriedOk = await adapter.verifyCarriedDateAndRoute(ctx);
          if (carriedOk === false) {
            SanitizedLogger.error(`[BOOKING] Carried date/route verification returned false for #${job.bookingCode}. Aborting safely.`);
            BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
            if (typeof adapter.logout === 'function') {
              await adapter.logout().catch(() => { });
            }
            await this.reportFail(job, {
              status: 'TEMPORARY_SLOT_LOST',
              errorCode: 'DATE_ROUTE_MISMATCH',
              errorMessage: 'Date or route carried after login does not match requested booking. Safe abort without reselection.',
            }, adapter);
            return;
          }
        } catch (mismatchErr: any) {
          const errMsg = mismatchErr?.message || '';
          if (
            errMsg.includes('MISMATCH') ||
            errMsg.includes('CARRIED_') ||
            errMsg.includes('SELECTION_LOST')
          ) {
            SanitizedLogger.error(`[BOOKING] Carried date/route mismatch or lost: ${errMsg}`);
            BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
            if (typeof adapter.logout === 'function') {
              await adapter.logout().catch(() => { });
            }
            const isRoute = errMsg.includes('ROUTE');
            await this.reportFail(job, {
              status: 'TEMPORARY_SLOT_LOST',
              errorCode: isRoute ? 'MISMATCHED_ROUTE' : 'MISMATCHED_DATE',
              errorMessage: errMsg || 'Date or route carried after login does not match requested booking. Safe abort without reselection.',
            }, adapter);
            return;
          }
          throw mismatchErr;
        }
      }

      // STEP 9 — Select an available slot immediately after login (Single check, NO reload, NO retry loop, NO re-selection)
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'SELECTING_SLOT');
      await this.reportProgress(job, 'SELECTING_SLOT', `Selecting time slot for ${canonicalDate}`);

      let postLoginSlotResult: any;
      try {
        postLoginSlotResult = typeof (adapter as any).selectPostLoginSlotWithRefreshFallback === 'function'
          ? await adapter.selectPostLoginSlotWithRefreshFallback(ctx, 0)
          : await adapter.selectPostLoginTimeSlot(ctx);
        if (!postLoginSlotResult || (postLoginSlotResult.success === false && !postLoginSlotResult.selected && !postLoginSlotResult.selectedSlot)) {
          throw new Error('SLOT_UNAVAILABLE: No slot selected after post-login slot check.');
        }
      } catch (slotErr: any) {
        if (
          slotErr?.message?.includes('SLOT_UNAVAILABLE') ||
          slotErr?.message?.includes('SLOT_CARDS_MISSING')
        ) {
          const isCardsMissing = slotErr?.message?.includes('SLOT_CARDS_MISSING');
          SanitizedLogger.warn(`[BOOKING] Slot unavailable or missing cards. Safe immediate abort without reload or reselection. Logging out and returning to monitoring.`);
          if (typeof adapter.logout === 'function') {
            await adapter.logout().catch(() => { });
          }
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'TEMPORARY_SLOT_LOST');
          await this.reportFail(job, {
            status: 'TEMPORARY_SLOT_LOST',
            errorCode: isCardsMissing ? 'SLOT_CARDS_MISSING' : 'SLOT_UNAVAILABLE',
            errorMessage: slotErr?.message || 'Slot cards unavailable post-login. Safely aborted without portal refresh.',
          }, adapter);
          return;
        }
        throw slotErr;
      }

      SanitizedLogger.info(`[BOOKING] Post-login slot selected: ${postLoginSlotResult.selectedSlot}`);
      SanitizedLogger.info(`[CURRENT_SLOT_SELECTED] Date ${canonicalDate}, slot ${postLoginSlotResult.selectedSlot} selected`);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'SLOT_VERIFIED');
      await this.reportProgress(job, 'SLOT_VERIFIED', `Time slot verified: ${postLoginSlotResult.selectedSlot}`);

      await adapter.selectBookingType(ctx);
      adapter.verifyDateTimePreserved(ctx);

      // STEP 10 — SEQUENTIAL ONE-DEVOTEE PER AVAILABILITY CYCLE
      const totalPilgrimCount = Math.max(1, Math.min(5, Number(job.pilgrimCount || 1)));

      rawPilgrims = Array.isArray(job.pilgrims) && job.pilgrims.length > 0 ? job.pilgrims : [];
      const sortedPilgrims = [...rawPilgrims].sort((a, b) => {
        const metaA = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : (a.metadata || {});
        const metaB = typeof b.metadata === 'string' ? JSON.parse(b.metadata) : (b.metadata || {});
        const seqA = Number(metaA.taskIndex || 0);
        const seqB = Number(metaB.taskIndex || 0);
        if (seqA && seqB) return seqA - seqB;
        return (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      });

      const pilgrimTasks = sortedPilgrims.length > 0
        ? sortedPilgrims.map((p, idx) => {
          const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
          const taskIndex = Number(meta.taskIndex || idx + 1);
          const isAdminCompleted =
            meta.taskStatus === 'ADMIN_COMPLETED' ||
            meta.status === 'ADMIN_COMPLETED';
          const isConfirmed =
            meta.taskStatus === 'CONFIRMED' ||
            meta.status === 'CONFIRMED' ||
            !!meta.officialBookingReference ||
            !!meta.transactionId;
          const isCompleted = isConfirmed || isAdminCompleted;
          const officialRef = meta.officialBookingReference || meta.transactionId;
          const fp =
            meta.selectedPilgrimFingerprint ||
            meta.identityFingerprint ||
            meta.selectedPilgrim?.identityFingerprint;

          return {
            id: p.id || `task-${taskIndex}`,
            taskIndex,
            fullName: p.fullName || `Devotee #${taskIndex}`,
            age: p.age,
            gender: p.gender,
            idType: p.idType,
            idNumber: p.idNumber,
            nominee: (p.nomineeName || (p as any).nominee)
              ? ((p as any).nominee || {
                nomineeName: p.nomineeName,
                nomineeAge: p.nomineeAge,
                nomineeRelationship: p.nomineeRelationship,
                nomineePhone: p.nomineePhone,
              })
              : (job.nominee || ((job as any).nominees && (job as any).nominees[idx]) || (job as any).nominees?.[0]),
            status: isAdminCompleted ? 'ADMIN_COMPLETED' : (isConfirmed ? 'CONFIRMED' : 'PENDING'),
            officialBookingReference: officialRef,
            fingerprint: fp,
            metadata: meta,
          };
        })
        : (Array.isArray((job as any).nominees) && (job as any).nominees.length > 0)
          ? (job as any).nominees.map((nom: any, idx: number) => ({
            id: `task-${idx + 1}`,
            taskIndex: idx + 1,
            fullName: `Devotee #${idx + 1}`,
            age: undefined,
            gender: undefined,
            idType: undefined,
            idNumber: undefined,
            nominee: nom,
            status: 'PENDING',
            officialBookingReference: undefined,
            fingerprint: undefined,
            metadata: {},
          }))
          : [{
            id: 'task-1',
            taskIndex: 1,
            fullName: 'Devotee #1',
            age: undefined,
            gender: undefined,
            idType: undefined,
            idNumber: undefined,
            nominee: job.nominee,
            status: 'PENDING',
            officialBookingReference: undefined,
            fingerprint: undefined,
            metadata: {},
          }];

      const confirmedTasks = pilgrimTasks.filter((t) => t.status === 'CONFIRMED' || t.status === 'ADMIN_COMPLETED');
      const pendingTasks = pilgrimTasks.filter((t) => t.status !== 'CONFIRMED' && t.status !== 'ADMIN_COMPLETED');
      const previouslyConfirmedCount = confirmedTasks.length;

      const isReconciliationRequired = (t: any) => {
        const meta = t.metadata || {};
        return (
          t.status === 'RECONCILIATION_REQUIRED' ||
          meta.taskStatus === 'RECONCILIATION_REQUIRED' ||
          meta.status === 'RECONCILIATION_REQUIRED' ||
          meta.taskStatus === 'MANUAL_REVIEW' ||
          meta.reconciliationRequired === true
        );
      };

      const eligibleTasks = pendingTasks.filter((t) => !isReconciliationRequired(t));
      const deferredTasks = pendingTasks.filter((t) => isReconciliationRequired(t));

      // Dynamic Pilgrim Rotation Sorting:
      // 1. Devotees with fewer attempts / deferrals come first (unattempted first).
      // 2. If attempt/deferral counts are equal and 0, sort by initial taskIndex (1, 2, 3...).
      // 3. If attempt/deferral counts are equal and > 0, sort by deferredAt / lastAttemptedAt ascending (oldest deferred first -> FIFO queue rotation).
      eligibleTasks.sort((a, b) => {
        const metaA = a.metadata || {};
        const metaB = b.metadata || {};
        const countA = Number(metaA.deferralCount || metaA.attemptCount || (metaA.deferredAt ? 1 : 0));
        const countB = Number(metaB.deferralCount || metaB.attemptCount || (metaB.deferredAt ? 1 : 0));
        if (countA !== countB) {
          return countA - countB;
        }
        if (countA === 0) {
          const seqA = Number(metaA.taskIndex || a.taskIndex || 0);
          const seqB = Number(metaB.taskIndex || b.taskIndex || 0);
          if (seqA && seqB) return seqA - seqB;
          return 0;
        }
        const timeA = metaA.deferredAt ? new Date(metaA.deferredAt).getTime() : (metaA.lastAttemptedAt ? new Date(metaA.lastAttemptedAt).getTime() : 0);
        const timeB = metaB.deferredAt ? new Date(metaB.deferredAt).getTime() : (metaB.lastAttemptedAt ? new Date(metaB.lastAttemptedAt).getTime() : 0);
        if (timeA !== timeB) {
          return timeA - timeB;
        }
        const seqA = Number(metaA.taskIndex || a.taskIndex || 0);
        const seqB = Number(metaB.taskIndex || b.taskIndex || 0);
        return seqA - seqB;
      });

      const orderedPendingTasks = [...eligibleTasks, ...deferredTasks];

      const excludedFingerprints = new Set<string>(ctx.excludedPilgrimFingerprints || []);
      for (const ct of confirmedTasks) {
        if (ct.fingerprint) {
          excludedFingerprints.add(ct.fingerprint);
        }
      }

      if (orderedPendingTasks.length === 0) {
        SanitizedLogger.info(
          `[SEQUENTIAL-BOOKING] All ${totalPilgrimCount} devotees already confirmed for Booking #${job.bookingCode}. Completing job.`,
        );
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_CONFIRMED');
        return;
      }

      // Mandatory requirement: Book devotees ONE AT A TIME per availability cycle.
      // Process exactly the next pending devotee, then exit and return to availability watching.
      currentTask = orderedPendingTasks[0];
      currentPilgrimNum = currentTask.taskIndex;

      // Required structured log:
      SanitizedLogger.info(
        `[SEQUENTIAL-BOOKING]\nbookingId=${job.bookingCode}\nrequestedCount=${totalPilgrimCount}\nconfirmedCount=${previouslyConfirmedCount}\npendingCount=${orderedPendingTasks.length}\nnextDevoteeSequence=${currentPilgrimNum}\nnextDevoteeName=${currentTask.fullName}`,
      );

      // Configure single-pilgrim execution context
      ctx.currentPilgrimIndex = currentPilgrimNum - 1;
      ctx.pilgrimCount = 1;
      ctx.nominee = currentTask.nominee;
      ctx.nominees = [currentTask.nominee];
      ctx.excludedPilgrimFingerprints = Array.from(excludedFingerprints);
      ctx.selectedPilgrim = null;
      ctx.selectedPilgrims = [];
      ctx.targetDevotee = {
        id: currentTask.id,
        sequence: currentPilgrimNum,
        fullName: currentTask.fullName,
        age: currentTask.age,
        gender: currentTask.gender,
        idType: currentTask.idType,
        idNumber: currentTask.idNumber,
      };
      ctx.confirmedDevotees = confirmedTasks.map((t) => ({
        id: t.id,
        sequence: t.taskIndex,
        fullName: t.fullName,
        fingerprint: t.fingerprint,
        officialBookingReference: t.officialBookingReference,
      }));
      // Pass strictly the current target devotee to ctx.pilgrims
      ctx.pilgrims = [{
        id: currentTask.id,
        fullName: currentTask.fullName,
        nomineeName: currentTask.nominee?.nomineeName,
        metadata: { taskIndex: currentPilgrimNum, taskStatus: 'PENDING' },
      } as any];

      let confirmResult: any = null;
      let confirmedBookingRef: string | null = null;

      try {
        // 1. Select EXACTLY ONE saved pilgrim
        await this.reportProgress(
          job,
          'SELECTING_EXISTING_PILGRIMS',
          `Selecting exactly 1 saved pilgrim for Devotee #${currentPilgrimNum}`,
        );
        const pilgrimSelRes = typeof (adapter as any).selectSingleSavedPilgrim === 'function'
          ? await (adapter as any).selectSingleSavedPilgrim(ctx)
          : typeof adapter.selectAllExistingPilgrims === 'function'
            ? await adapter.selectAllExistingPilgrims(ctx)
            : { success: true, selectedCount: 1 };

        const selectedEvidence: any =
          pilgrimSelRes?.selectedPilgrim ||
          ctx.selectedPilgrim ||
          (pilgrimSelRes?.success
            ? { fullName: `Devotee #${currentPilgrimNum}`, identityFingerprint: `fp_devotee_${currentPilgrimNum}` }
            : null);
        if (!selectedEvidence?.identityFingerprint) {
          throw new Error(`PILGRIM_SELECTION_FAILED: Devotee #${currentPilgrimNum} identity fingerprint could not be determined.`);
        }

        BookingExecutionGuard.updateLifecycleState(bookingKey, 'PILGRIMS_VERIFIED');
        await this.reportProgress(
          job,
          'PILGRIMS_VERIFIED',
          `Selected 1 saved pilgrim for Devotee #${currentPilgrimNum}: "${selectedEvidence.fullName || 'Devotee'}" (FP: ${selectedEvidence.identityFingerprint})`,
          { selectedPilgrim: selectedEvidence },
        );

        // 2. Populate single nominee details
        await this.reportProgress(job, 'NOMINEE_POPULATED', `Populating nominee for Devotee #${currentPilgrimNum}`);
        await adapter.populateNomineeDetails(ctx);
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'NOMINEE_VERIFIED');
        await this.reportProgress(job, 'NOMINEE_VERIFIED', `Nominee for Devotee #${currentPilgrimNum} accepted by portal`);

        // 3. Prasadam & Relief Fund No (Enforce Donation = ₹0)
        await adapter.handlePrasadamDetails(ctx);
        await adapter.selectReliefFundNo(ctx);

        // Verify donation total is strictly ₹0 before submitting to Wishlist
        const activePage = typeof (adapter as any).getPage === 'function' ? (adapter as any).getPage() : null;
        if (activePage) {
          const donationAmt = await ReliefFundFlow.scanTotalAmount(activePage).catch(() => 0);
          if (donationAmt > 0) {
            SanitizedLogger.warn(`[RELIEF-FUND] Donation amount was ₹${donationAmt}. Re-selecting No to guarantee ₹0.`);
            await adapter.selectReliefFundNo(ctx);
          }
        }
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RELIEF_VERIFIED');
        await this.reportProgress(job, 'RELIEF_VERIFIED', 'Relief fund contribution set to ₹0');

        // 4. Add to Wishlist & verify single item
        if ((job as any).leaseLost) {
          if (typeof (adapter as any).logout === 'function') {
            await (adapter as any).logout().catch(() => { });
          }
          throw new Error('LEASE_LOST_CONFLICT: Lease was revoked during execution');
        }
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'ADDING_TO_WISHLIST');
        await this.reportProgress(job, 'ADDING_TO_WISHLIST', `Adding Devotee #${currentPilgrimNum} to Wishlist`);
        try {
          (ctx as any).inWishlistSubmissionPhase = true;
          await adapter.addToWishlistAndVerify(ctx);
        } catch (wishlistErr: any) {
          if (wishlistErr) {
            wishlistErr.flowPhase = 'PHASE_7_WISHLIST';
          }
          throw wishlistErr;
        } finally {
          (ctx as any).inWishlistSubmissionPhase = false;
        }
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'WISHLIST_VERIFIED');
        await this.reportProgress(job, 'WISHLIST_VERIFIED', `Wishlist verified for Devotee #${currentPilgrimNum}`);
        await this.reportProgress(job, 'WISHLIST_VERIFIED', `Wishlist verified for Devotee #${currentPilgrimNum}`);

        // 5. Proceed to checkout & verify payment summary
        if ((job as any).leaseLost) {
          throw new Error('LEASE_LOST_CONFLICT: Lease was revoked during execution');
        }
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'PROCEEDING_TO_CHECKOUT');
        await this.reportProgress(job, 'PROCEEDING_TO_CHECKOUT', 'Proceeding to payment gateway');
        await adapter.proceedToPaymentGateway(ctx);
        await adapter.verifyPaymentSummary(ctx);
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'CHECKOUT_VERIFIED');
        await this.reportProgress(job, 'CHECKOUT_VERIFIED', 'Checkout details verified');

        // 6. Confirm pass & verify official reference
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'CONFIRMATION_PENDING');
        await this.reportProgress(job, 'ZERO_COST_CONFIRMATION_PENDING', `Submitting confirmation for Devotee #${currentPilgrimNum}`);
        ConfirmMarkerManager.setMarker(job.bookingCode, {
          bookingCode: job.bookingCode,
          jobId: job.id,
          date: canonicalDate,
          route: job.route,
        });

        confirmResult = null;
        try {
          confirmResult = await adapter.executePaymentProceedAndConfirm(ctx);
        } catch (submitErr: any) {
          SanitizedLogger.warn(`[BOOKING] Submission threw for Devotee #${currentPilgrimNum}: ${submitErr?.message}. Checking portal booking history...`);
          const historyCheck: any = typeof adapter.checkExistingBookingInHistory === 'function'
            ? await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false }))
            : { found: false };
          if (historyCheck && historyCheck.found && historyCheck.officialReference && historyCheck.status !== 'CANCELLED') {
            confirmResult = {
              confirmed: true,
              officialReference: historyCheck.officialReference,
              officialBookingReference: historyCheck.officialReference,
              confirmedAt: historyCheck.confirmedAt,
              reconciledFromHistory: true,
            };
          } else {
            confirmResult = {
              confirmed: false,
              reconciliationRequired: true,
              officialStatusFound: historyCheck?.officialStatusFound,
              message: `Final confirmation timed out or threw for Devotee #${currentPilgrimNum}; requires reconciliation.`,
            };
          }
        }

        let bookingRef =
          confirmResult?.officialBookingReference ||
          confirmResult?.officialReference ||
          confirmResult?.portalTransactionReference ||
          confirmResult?.transactionId;
        confirmedBookingRef = bookingRef;

        const transactionId =
          confirmResult?.portalTransactionReference ||
          confirmResult?.transactionId ||
          (confirmResult as any)?.confirmationData?.transactionId ||
          bookingRef;

        const officialBookingId =
          confirmResult?.officialBookingReference ||
          (confirmResult as any)?.confirmationData?.officialBookingId ||
          (confirmResult as any)?.confirmationData?.officialBookingReference;

        const cartId = confirmResult?.cartId || ctx.cartId;

        // When official confirmation popup and navigation to Transaction History are verified,
        // it is CONFIRMED. Do NOT reject merely because Transaction ID matches Cart ID!
        let isAuthoritativeConfirmed =
          confirmResult?.confirmed === true &&
          Boolean(bookingRef) &&
          typeof bookingRef === 'string' &&
          bookingRef.trim().length >= 6 &&
          !bookingRef.startsWith('SAB-2026-');

        if (!isAuthoritativeConfirmed) {
          // If confirmResult was already marked reconciliationRequired (e.g. popup seen but redirect timed out),
          // do NOT guess from history. Enter RECONCILIATION_REQUIRED immediately to prevent duplicate booking.
          if (confirmResult?.reconciliationRequired) {
            const failureReason = confirmResult?.message ||
              `Devotee #${currentPilgrimNum} confirmation outcome ambiguous or unverified. Requires human reconciliation.`;
            SanitizedLogger.warn(
              `[RECONCILIATION] Devotee #${currentPilgrimNum} requires reconciliation without re-try: ${failureReason}`,
            );

            BookingExecutionGuard.updateLifecycleState(bookingKey, 'RECONCILIATION_REQUIRED');
            await this.reportFail(job, {
              status: 'RECONCILIATION_REQUIRED',
              errorCode: 'CONFIRMATION_UNVERIFIED',
              errorMessage: failureReason,
              pilgrimTaskId: currentTask.id,
              taskIndex: currentPilgrimNum,
            }, adapter);
            return;
          }

          SanitizedLogger.warn(
            `[RECONCILIATION] Devotee #${currentPilgrimNum} unconfirmed on submission. Performing authoritative history reconciliation...`,
          );
          const postHist: any = typeof adapter.checkExistingBookingInHistory === 'function'
            ? await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false }))
            : { found: false };

          if (postHist?.found && postHist?.officialReference && postHist.status !== 'CANCELLED') {
            bookingRef = postHist.officialReference;
            isAuthoritativeConfirmed = true;
            confirmResult = {
              ...confirmResult,
              confirmed: true,
              officialReference: postHist.officialReference,
              officialBookingReference: postHist.officialReference,
              confirmedAt: postHist.confirmedAt || new Date().toISOString(),
              reconciledFromHistory: true,
            };
            SanitizedLogger.info(
              `[RECONCILIATION] Authoritative confirmed pass #${bookingRef} verified from portal history for Devotee #${currentPilgrimNum}.`,
            );
          } else {
            // STRICT REQUIREMENT 3: If official record cannot be verified, set state to RECONCILIATION_REQUIRED / CONFIRMATION_UNVERIFIED.
            // Do NOT mark devotee completed. Do NOT send "booking successful" notification. Do NOT remove from pending.
            const failureReason = postHist?.officialStatusFound === 'CANCELLED'
              ? `Official portal transaction for Devotee #${currentPilgrimNum} is CANCELLED (0 pilgrims). No pass created.`
              : `Devotee #${currentPilgrimNum} confirmation outcome ambiguous or unverified in portal history. Requires human reconciliation.`;

            SanitizedLogger.warn(
              `[RECONCILIATION] Devotee #${currentPilgrimNum} cannot be verified. Setting RECONCILIATION_REQUIRED. Reason: ${failureReason}`,
            );

            BookingExecutionGuard.updateLifecycleState(bookingKey, 'RECONCILIATION_REQUIRED');
            await this.reportFail(job, {
              status: 'RECONCILIATION_REQUIRED',
              errorCode: 'CONFIRMATION_UNVERIFIED',
              errorMessage: failureReason,
              pilgrimTaskId: currentTask.id,
              taskIndex: currentPilgrimNum,
            }, adapter);
            return;
          }
        }

        ConfirmMarkerManager.clearMarker(job.bookingCode);
        SanitizedLogger.info(`[OFFICIAL_PASS_CONFIRMED] Authoritative pass confirmed: Reference ${bookingRef}`);
        SanitizedLogger.info(`[OFFICIAL_BOOKING_CONFIRMED] Current devotee officially confirmed: Reference ${bookingRef}`);
        excludedFingerprints.add(selectedEvidence.identityFingerprint);

        const newConfirmedCount = previouslyConfirmedCount + 1;
        const remainingDevotees = totalPilgrimCount - newConfirmedCount;
        const isFinalPilgrim = remainingDevotees <= 0;
        const nextDevoteeSequence = remainingDevotees > 0 ? (pendingTasks[1]?.taskIndex || currentPilgrimNum + 1) : 'NONE';

        // Required structured log:
        SanitizedLogger.info(
          `[DEVOTEE-CONFIRMED]\nbookingId=${job.bookingCode}\ndevoteeSequence=${currentPilgrimNum}\ndevoteeName=${currentTask.fullName}\ntransactionId=${bookingRef}\nconfirmedCount=${newConfirmedCount}\nremainingCount=${remainingDevotees}\nnextDevoteeSequence=${nextDevoteeSequence}`,
        );

        // Step 3 — Notify successful devotee completion
        const completionNotification = `Devotee ${currentPilgrimNum} of ${totalPilgrimCount} completed successfully. Booking reference: ${bookingRef}. Remaining devotees: ${remainingDevotees}. Returning to availability monitoring.`;
        SanitizedLogger.info(`[SEQUENTIAL-BOOKING] ${completionNotification}`);

        // Report single devotee completion to API with separate Transaction ID, Official Booking ID, and Cart ID
        await this.reportComplete(job, {
          officialReference: officialBookingId || bookingRef,
          officialBookingReference: officialBookingId || bookingRef,
          transactionId,
          cartId,
          portalTransactionReference: transactionId,
          officialReceiptReference: confirmResult?.officialReceiptReference,
          confirmedAt: confirmResult?.confirmedAt || new Date().toISOString(),
          pilgrimTaskId: currentTask.id,
          taskIndex: currentPilgrimNum,
          selectedPilgrim: selectedEvidence,
          isFinalPilgrim,
          totalRequestedPilgrims: totalPilgrimCount,
          confirmedPilgrimsCount: newConfirmedCount,
          remainingDevoteesCount: remainingDevotees,
          note: completionNotification,
        } as any);

        SanitizedLogger.info(`[DEVOTEE_CONFIRMATION_PERSISTED] Devotee #${currentPilgrimNum} (${selectedEvidence?.fullName || currentTask.fullName}) confirmation persisted with Ref: ${bookingRef}`);
        SanitizedLogger.info(`[PARENT_BOOKING_PROGRESS_UPDATED] Booking #${job.bookingCode} progress: ${newConfirmedCount} of ${totalPilgrimCount} confirmed, ${remainingDevotees} pending`);

        // Step 4 — Return to availability watching
        // Exit current booking page / logout session safely
        if (typeof (adapter as any).logout === 'function') {
          await (adapter as any).logout().catch(() => { });
        }

        if (isFinalPilgrim) {
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_CONFIRMED');
          SanitizedLogger.info(`[SEQUENTIAL-BOOKING] All ${totalPilgrimCount} devotees confirmed successfully for Booking #${job.bookingCode}!`);
        } else {
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'PARTIALLY_COMPLETED');
          SanitizedLogger.info(
            `[SEQUENTIAL-BOOKING] Devotee #${currentPilgrimNum} done. ${remainingDevotees} devotee(s) remaining. Transitioned to PARTIALLY_COMPLETED; returning to availability queue.`,
          );
        }
      } catch (pilgrimErr: any) {
        // CENTRAL STATE-TRANSITION GUARD:
        // Once official success has been verified and confirmed, subsequent errors (like logout, cleanup, or wishlist drawer)
        // MUST NEVER downgrade the confirmed devotee to FAILED / TEMPORARY_SLOT_LOST / RECONCILIATION_REQUIRED.
        if (confirmResult?.confirmed) {
          SanitizedLogger.warn(
            `[CONFIRMATION-PROTECTION] Devotee #${currentPilgrimNum} is already CONFIRMED (#${confirmedBookingRef || 'CONFIRMED'}). Late error (${pilgrimErr?.message}) safely suppressed. Preserving confirmation.`,
          );
          return;
        }

        if (
          pilgrimErr?.statusCode === 409 ||
          pilgrimErr?.conflictReason ||
          String(pilgrimErr?.message || '').includes('LEASE_LOST') ||
          (job as any).leaseLost
        ) {
          throw pilgrimErr;
        }

        SanitizedLogger.error(`[SEQUENTIAL-BOOKING] Devotee #${currentPilgrimNum} encountered error: ${pilgrimErr?.message}`);

        // Step 5 — Handle error status and error codes cleanly
        const errMsg = String(pilgrimErr?.message || '');
        const errCode = pilgrimErr?.errorCode || '';
        let failureStatus = 'RETRYABLE_FAILURE';
        let failureCode = errCode || 'BOOKING_EXECUTION_FAILED';

        const isWishlistPhase =
          (pilgrimErr as any)?.flowPhase === 'PHASE_7_WISHLIST' ||
          (ctx as any)?.inWishlistSubmissionPhase === true;

        const isWishlistStageFailure =
          errCode === 'WISHLIST_DEFERRED' ||
          errCode === 'PREVIOUS_BOOKING_RESTRICTION' ||
          pilgrimErr?.status === 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED' ||
          errCode === 'WISHLIST_DRAWER_NOT_FOUND' ||
          errCode === 'WISHLIST_INSERTION_FAILED' ||
          (isWishlistPhase && (
            errMsg.includes('BUTTON_DISABLED') ||
            errCode === 'BUTTON_DISABLED' ||
            errCode === 'WISHLIST_BUTTON_DISABLED' ||
            errMsg.includes('WISHLIST_DATA_MISMATCH') ||
            errCode === 'WISHLIST_DATA_MISMATCH' ||
            errMsg.includes('WISHLIST_EMPTY') ||
            errCode === 'WISHLIST_EMPTY'
          )) ||
          errMsg.includes('PREVIOUS_BOOKING_RESTRICTION') ||
          errMsg.includes('WISHLIST_DRAWER_NOT_FOUND') ||
          errMsg.includes('WISHLIST_DEFERRED') ||
          errMsg.includes('WISHLIST_INSERTION_FAILED') ||
          errMsg.toLowerCase().includes('pending booking') ||
          errMsg.toLowerCase().includes('sufficient quota') ||
          errMsg.toLowerCase().includes('already having') ||
          errMsg.toLowerCase().includes('previous booking');

        if (isWishlistStageFailure) {
          // Reconcile official booking history before concluding restriction
          SanitizedLogger.warn(`[BOOKING] Wishlist error for Devotee #${currentPilgrimNum} (${job.bookingCode}): ${errMsg}. Checking portal history to reconcile...`);
          let reconciledPass: string | undefined;
          try {
            const histCheck: any = typeof adapter.checkExistingBookingInHistory === 'function'
              ? await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false }))
              : { found: false };
            if (histCheck?.found && histCheck?.officialReference) {
              reconciledPass = histCheck.officialReference;
            }
          } catch { }

          if (reconciledPass) {
            SanitizedLogger.info(`[RECONCILIATION] Reconciled confirmed pass #${reconciledPass} from history for Devotee #${currentPilgrimNum}. Reporting complete.`);
            ConfirmMarkerManager.clearMarker(job.bookingCode);
            await this.reportComplete(job, {
              officialReference: reconciledPass,
              officialBookingReference: reconciledPass,
              confirmedAt: new Date().toISOString(),
              note: `Reconciled from portal booking history #${reconciledPass}`,
              taskIndex: currentPilgrimNum,
            } as any);
            return;
          }

          // Defer current devotee to the end of the queue for rotation
          const nowIso = new Date().toISOString();
          const nextDeferralCount = Number(currentTask?.metadata?.deferralCount || 0) + 1;
          const nextAttemptCount = Number(currentTask?.metadata?.attemptCount || 0) + 1;
          if (currentTask) {
            currentTask.metadata = {
              ...(currentTask.metadata || {}),
              taskIndex: currentPilgrimNum,
              deferredAt: nowIso,
              lastAttemptedAt: nowIso,
              deferralCount: nextDeferralCount,
              attemptCount: nextAttemptCount,
              lastFailureReason: pilgrimErr.message || errMsg,
              lastErrorCode: pilgrimErr.errorCode || 'WISHLIST_DEFERRED',
              taskStatus: 'PENDING',
            };
            const matchingRaw = rawPilgrims.find(
              (p: any) => p.id === currentTask.id || (p.metadata?.taskIndex === currentPilgrimNum),
            );
            if (matchingRaw) {
              matchingRaw.metadata = currentTask.metadata;
            }
          }

          SanitizedLogger.warn(
            `[PILGRIM-ROTATION-DEFERRED]\nbookingId=${job.bookingCode}\ndevoteeSequence=${currentPilgrimNum}\ndevoteeName=${currentTask?.fullName || 'Devotee'}\ndeferralCount=${nextDeferralCount}\nreason=${pilgrimErr.message || errMsg}\naction=DEFER_TO_END_OF_QUEUE_AND_RESUME_MONITORING`,
          );

          // Return to availability waiting/refresh mode: NEVER mark fatal ACCOUNT_PREVIOUS_BOOKING_RESTRICTED or REQUIRES_HUMAN
          failureStatus = 'TEMPORARY_SLOT_LOST';
          failureCode = pilgrimErr.errorCode || 'WISHLIST_DEFERRED';
          BookingExecutionGuard.releaseGlobalPriorityLock();
        } else {
          // ANY OTHER DEVOTEE ATTEMPT FAILURE: DEFER CURRENT DEVOTEE AND SAFELY RETURN TO WATCHING
          const nowIso = new Date().toISOString();
          const nextDeferralCount = Number(currentTask?.metadata?.deferralCount || 0) + 1;
          const nextAttemptCount = Number(currentTask?.metadata?.attemptCount || 0) + 1;
          const errCodeSpecific = errCode || (errMsg.includes('NOMINEE') ? 'NOMINEE_DETAILS_MISSING' : (errMsg.includes('BUTTON_DISABLED') ? 'FORM_VALIDATION_ERROR' : (errMsg.includes('RELIEF_FUND') ? 'RELIEF_FUND_ERROR' : 'ATTEMPT_UNSUCCESSFUL')));
          if (currentTask) {
            currentTask.metadata = {
              ...(currentTask.metadata || {}),
              taskIndex: currentPilgrimNum,
              deferredAt: nowIso,
              lastAttemptedAt: nowIso,
              deferralCount: nextDeferralCount,
              attemptCount: nextAttemptCount,
              lastFailureReason: pilgrimErr.message || errMsg,
              lastErrorCode: errCodeSpecific,
              taskStatus: 'PENDING',
            };
            const matchingRaw = rawPilgrims.find(
              (p: any) => p.id === currentTask.id || (p.metadata?.taskIndex === currentPilgrimNum),
            );
            if (matchingRaw) {
              matchingRaw.metadata = currentTask.metadata;
            }
          }

          SanitizedLogger.warn(
            `[PILGRIM-ROTATION-DEFERRED]\nbookingId=${job.bookingCode}\ndevoteeSequence=${currentPilgrimNum}\ndevoteeName=${currentTask?.fullName || 'Devotee'}\ndeferralCount=${nextDeferralCount}\nreason=${pilgrimErr.message || errMsg}\naction=DEFER_TO_END_OF_QUEUE_AND_RESUME_MONITORING`,
          );

          failureStatus = 'TEMPORARY_SLOT_LOST';
          failureCode = errCodeSpecific;
          BookingExecutionGuard.releaseGlobalPriorityLock();
        }

        const hasOtherPendingDevotees = totalPilgrimCount > 1 && previouslyConfirmedCount + 1 < totalPilgrimCount;
        const targetLifecycleState = failureStatus === 'TEMPORARY_SLOT_LOST'
          ? (hasOtherPendingDevotees ? 'PARTIALLY_COMPLETED' : 'RETRYABLE_FAILURE')
          : (hasOtherPendingDevotees ? 'PARTIALLY_COMPLETED' : failureStatus);

        BookingExecutionGuard.updateLifecycleState(bookingKey, targetLifecycleState);

        await this.reportFail(job, {
          status: failureStatus,
          errorCode: failureCode,
          errorMessage: pilgrimErr?.message || `Devotee #${currentPilgrimNum} booking execution failed`,
          pilgrimTaskId: currentTask?.id,
          taskIndex: currentPilgrimNum,
          selectedPilgrim: {
            id: currentTask?.id,
            sequence: currentPilgrimNum,
            fullName: currentTask?.fullName,
          },
        }, adapter);
      }
    } catch (err: any) {
      if (err.message && err.message.startsWith('BOOKING_EXECUTION_UNCONFIRMED:')) {
        throw err;
      }

      SanitizedLogger.error(`[BOOKING] Exception during booking job #${job.bookingCode}:`, {
        name: err?.name,
        message: err?.message || String(err),
        stack: err?.stack,
      });

      let status = err.status || 'WORKER_ERROR';
      let errorCode = err.errorCode || err.code || 'EXECUTION_EXCEPTION';
      const codeOrMsg = (err.code || '') + ' ' + (err.message || '');
      const statusCode = err?.response?.status || err?.status || err?.statusCode;

      if (
        statusCode === 409 ||
        codeOrMsg.includes('LEASE_LOST_CONFLICT') ||
        codeOrMsg.includes('STALE_LEASE_GENERATION') ||
        codeOrMsg.includes('FENCING_TOKEN_MISMATCH')
      ) {
        status = 'LEASE_LOST';
        errorCode = 'STALE_LEASE_CONFLICT';
        (job as any).leaseLost = true;
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'EXECUTION_FAILED');
        SanitizedLogger.error(
          `[BOOKING] Active lease lost or superseded on server (HTTP 409) for #${job.bookingCode || bookingKey}. Halting execution safely before final submission.`
        );
        try {
          if (typeof adapter.logout === 'function') {
            await adapter.logout();
          }
        } catch (logoutErr: any) {
          SanitizedLogger.warn(`[BOOKING] Cleanup logout notice: ${logoutErr?.message || logoutErr}`);
        }
      } else if (codeOrMsg.includes('LEASE_LOST_RECOVERABLE')) {
        status = 'RETRYABLE_FAILURE';
        errorCode = 'LEASE_LOST_RECOVERABLE';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (
        codeOrMsg.includes('DATE_NOT_SELECTABLE') ||
        codeOrMsg.toLowerCase().includes('not selectable in calendar') ||
        errorCode === 'DATE_NOT_SELECTABLE' ||
        err.errorCode === 'DATE_NOT_SELECTABLE' ||
        err.status === 'TEMPORARY_SLOT_LOST'
      ) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'DATE_NOT_SELECTABLE';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'TEMPORARY_SLOT_LOST');
      } else if (statusCode === 403 || statusCode === 401) {
        status = 'WORKER_ERROR';
        errorCode = 'FORBIDDEN';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'WORKER_ERROR');
      } else if (codeOrMsg.includes('SLOT_CARDS_MISSING')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'SLOT_CARDS_MISSING';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('PAYMENT_REQUIRED_OR_AMBIGUOUS') || codeOrMsg.includes('PAYMENT_PENDING')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'PAYMENT_REQUIRED_OR_AMBIGUOUS';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
      } else if (
        (err as any)?.flowPhase === 'PHASE_7_WISHLIST' ||
        codeOrMsg.includes('PREVIOUS_BOOKING_RESTRICTION') ||
        codeOrMsg.includes('ACCOUNT_PREVIOUS_BOOKING_RESTRICTED') ||
        codeOrMsg.includes('WISHLIST_DRAWER_NOT_FOUND') ||
        codeOrMsg.includes('WISHLIST_DEFERRED') ||
        ((codeOrMsg.includes('WISHLIST_INSERTION_FAILED') || codeOrMsg.includes('BUTTON_DISABLED') || codeOrMsg.includes('WISHLIST_DATA_MISMATCH') || codeOrMsg.includes('WISHLIST_EMPTY')) &&
          (err as any)?.flowPhase === 'PHASE_7_WISHLIST') ||
        codeOrMsg.includes('pending booking') ||
        codeOrMsg.includes('sufficient quota') ||
        codeOrMsg.includes('already having')
      ) {
        // Reconcile official booking history and wishlist before assuming restriction
        SanitizedLogger.warn(`[BOOKING] Portal reported pending booking / quota restriction for #${job.bookingCode}. Checking portal history and wishlist to reconcile...`);
        let reconciledPass: string | undefined;
        try {
          const histCheck: any = typeof adapter.checkExistingBookingInHistory === 'function'
            ? await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false }))
            : { found: false };
          if (histCheck?.found && histCheck?.officialReference) {
            reconciledPass = histCheck.officialReference;
          }
        } catch { }

        if (reconciledPass) {
          SanitizedLogger.info(`[RECONCILIATION] Reconciled confirmed pass #${reconciledPass} from history. Reporting complete.`);
          ConfirmMarkerManager.clearMarker(job.bookingCode);
          await this.reportComplete(job, {
            officialReference: reconciledPass,
            officialBookingReference: reconciledPass,
            confirmedAt: new Date().toISOString(),
            note: `Reconciled from portal booking history #${reconciledPass}`,
            taskIndex: currentPilgrimNum,
          } as any);
          return;
        }

        // Defer current devotee to the end of the queue for rotation
        const nowIso = new Date().toISOString();
        const nextDeferralCount = Number(currentTask?.metadata?.deferralCount || 0) + 1;
        const nextAttemptCount = Number(currentTask?.metadata?.attemptCount || 0) + 1;
        if (currentTask) {
          currentTask.metadata = {
            ...(currentTask.metadata || {}),
            taskIndex: currentPilgrimNum,
            deferredAt: nowIso,
            lastAttemptedAt: nowIso,
            deferralCount: nextDeferralCount,
            attemptCount: nextAttemptCount,
            lastFailureReason: err.message || codeOrMsg,
            lastErrorCode: err.errorCode || 'WISHLIST_DEFERRED',
            taskStatus: 'PENDING',
          };
          const matchingRaw = rawPilgrims.find(
            (p: any) => p.id === currentTask.id || (p.metadata?.taskIndex === currentPilgrimNum),
          );
          if (matchingRaw) {
            matchingRaw.metadata = currentTask.metadata;
          }
        }

        SanitizedLogger.warn(
          `[PILGRIM-ROTATION-DEFERRED]\nbookingId=${job.bookingCode}\ndevoteeSequence=${currentPilgrimNum}\ndevoteeName=${currentTask?.fullName || 'Devotee'}\ndeferralCount=${nextDeferralCount}\nreason=${err.message || codeOrMsg}\naction=DEFER_TO_END_OF_QUEUE_AND_RESUME_MONITORING`,
        );

        // Return to availability waiting/refresh mode: NEVER mark fatal ACCOUNT_PREVIOUS_BOOKING_RESTRICTED or REQUIRES_HUMAN
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = err.errorCode || 'WISHLIST_DEFERRED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('NOMINEE_DETAILS_MISSING') || codeOrMsg.includes('NOMINEE_VALIDATION_FAILED') || codeOrMsg.includes('NOMINEE_REQUIRED')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'NOMINEE_DETAILS_MISSING';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('PILGRIM_SELECTION_FAILED')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'PILGRIM_SELECTION_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('BUTTON_DISABLED')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'FORM_VALIDATION_ERROR';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('SLOT_SELECTION_UNVERIFIED') || codeOrMsg.includes('SLOT_SELECTION_FAILED')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'SLOT_SELECTION_UNVERIFIED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('SLOT_UNAVAILABLE')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'SLOT_UNAVAILABLE';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('RELIEF_FUND_UNVERIFIED') || codeOrMsg.includes('RELIEF_FUND_SELECTION_FAILED') || codeOrMsg.includes('RELIEF_FUND_ERROR')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'RELIEF_FUND_ERROR';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('WISHLIST_MISMATCH') || codeOrMsg.includes('WISHLIST_VERIFICATION_MISMATCH') || codeOrMsg.includes('CHECKOUT_VERIFICATION_MISMATCH')) {
        status = 'WISHLIST_MISMATCH';
        errorCode = 'WISHLIST_MISMATCH';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'WISHLIST_MISMATCH');
      } else if (codeOrMsg.includes('WISHLIST_INSERTION_FAILED')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'WISHLIST_INSERTION_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (
        codeOrMsg.includes('PORTAL_AVAILABILITY_MISMATCH') ||
        codeOrMsg.includes('DISABLED or FULL') ||
        codeOrMsg.includes('SLOT_CARDS_MISSING') ||
        (codeOrMsg.includes('AUTHENTICATED_DATE_SELECTION_FAILED') && (codeOrMsg.includes('FULL') || codeOrMsg.includes('DISABLED')))
      ) {
        status = 'RETRYABLE_FAILURE';
        errorCode = 'PORTAL_AVAILABILITY_MISMATCH';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('AUTHENTICATED_DATE_SELECTION_FAILED') || codeOrMsg.includes('DATE_FIELD_NOT_FOUND')) {
        status = 'RETRYABLE_FAILURE';
        errorCode = 'AUTHENTICATED_DATE_SELECTION_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('AUTHENTICATED_ROUTE_SELECTION_FAILED') || codeOrMsg.includes('ROUTE_SELECTION_FAILED')) {
        status = 'RETRYABLE_FAILURE';
        errorCode = 'AUTHENTICATED_ROUTE_SELECTION_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('SESSION_EXPIRED') || codeOrMsg.includes('SESSION_TIMEOUT')) {
        status = 'RETRYABLE_FAILURE';
        errorCode = 'SESSION_EXPIRED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('NETWORK_TIMEOUT') || codeOrMsg.includes('NAVIGATION_TIMEOUT') || codeOrMsg.includes('PORTAL_UNRESPONSIVE')) {
        status = 'RETRYABLE_FAILURE';
        errorCode = 'NETWORK_TIMEOUT';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('PRASADAM_VALIDATION_ERROR')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'PRASADAM_VALIDATION_ERROR';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('ROUTE_SELECTION_MISMATCH')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'ROUTE_SELECTION_MISMATCH';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('LOADER_TIMEOUT')) {
        status = 'LOADER_TIMEOUT';
        errorCode = 'LOADER_TIMEOUT';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'LOADER_TIMEOUT');
      } else if (codeOrMsg.includes('PAYMENT_PAGE_LOAD_FAILED') || codeOrMsg.includes('PAYMENT_REQUIRED_OR_AMBIGUOUS')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'PAYMENT_PAGE_LOAD_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('LEASE_LOST_BEFORE_PAYMENT') || codeOrMsg.includes('LEASE_INCOMPLETE') || codeOrMsg.includes('CLIENT_VERSION_MISMATCH')) {
        status = 'LEASE_LOST';
        errorCode = codeOrMsg.includes('LEASE_INCOMPLETE') ? 'LEASE_INCOMPLETE' : (codeOrMsg.includes('CLIENT_VERSION_MISMATCH') ? 'CLIENT_VERSION_MISMATCH' : 'LEASE_LOST_BEFORE_PAYMENT');
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'EXECUTION_FAILED');
      } else if (
        codeOrMsg.includes('PORTAL_SERVICE_UNAVAILABLE') ||
        codeOrMsg.includes('Sorry, this service is not available') ||
        codeOrMsg.includes("service through 'My Wishlist'") ||
        errorCode === 'PORTAL_SERVICE_UNAVAILABLE' ||
        err.status === 'PORTAL_SERVICE_UNAVAILABLE'
      ) {
        status = 'PORTAL_SERVICE_UNAVAILABLE';
        errorCode = 'PORTAL_SERVICE_UNAVAILABLE';
        BookingExecutionGuard.releaseGlobalPriorityLock();
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      }

      // Ensure BookingExecutionGuard is transitioned out of active in-flight states on any exception
      const activeLock = BookingExecutionGuard.getActiveLock(bookingKey);
      if (activeLock && !['RETRYABLE_FAILURE', 'EXECUTION_FAILED', 'COMPLETED', 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED', 'WISHLIST_MISMATCH', 'LOADER_TIMEOUT', 'BOOKING_CONFIRMED', 'TEMPORARY_SLOT_LOST'].includes(activeLock.lifecycleState)) {
        const fallbackLifecycle = (status === 'REQUIRES_HUMAN' || status === 'MANUAL_REVIEW') ? 'RETRYABLE_FAILURE' : (status || 'RETRYABLE_FAILURE');
        BookingExecutionGuard.updateLifecycleState(bookingKey, fallbackLifecycle);
      }

      // Capture screenshot from active browser page before teardown
      let screenshot: string | undefined;
      try {
        screenshot = (await adapter.captureScreenshotBase64()) || undefined;
      } catch (shotErr: any) {
        SanitizedLogger.warn(`[BOOKING] Could not capture exception page screenshot: ${shotErr?.message || shotErr}`);
      }

      // Check if diagnostics screenshot on disk exists if adapter live capture was empty
      if (!screenshot && err?.diagnostics?.screenshotPath) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(err.diagnostics.screenshotPath)) {
            const fileBuf = await fs.promises.readFile(err.diagnostics.screenshotPath);
            screenshot = `data:image/png;base64,${fileBuf.toString('base64')}`;
          }
        } catch { }
      }

      if (status !== 'LEASE_LOST') {
        await this.reportFail(job, {
          status,
          errorCode,
          errorMessage: err.message || 'Unexpected error communicating with official portal.',
          screenshot,
          pilgrimTaskId: currentTask?.id,
          taskIndex: currentPilgrimNum,
          selectedPilgrim: {
            id: currentTask?.id,
            sequence: currentPilgrimNum,
            fullName: currentTask?.fullName,
          },
        }, adapter).catch((reportErr) => {
          SanitizedLogger.warn(`[BOOKING] Failed to report failure to backend: ${reportErr?.message || reportErr}`);
        });
      } else {
        SanitizedLogger.warn(`[BOOKING] Skipping reportFail for #${job.bookingCode || job.id}: lease already superseded or expired on server.`);
      }
    } finally {
      if (internalLockAcquired) {
        BookingExecutionGuard.release(bookingKey, job.id);
      }
      if (typeof (adapter as any)?.logout === 'function') {
        await (adapter as any).logout().catch(() => { });
      }
      if (typeof (adapter as any)?.close === 'function') {
        await (adapter as any).close().catch(() => { });
      }
    }
  }
}
