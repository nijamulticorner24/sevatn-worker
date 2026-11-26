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
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
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
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
          await this.reportFail(job, {
            status: 'REQUIRES_HUMAN',
            errorCode: loginResult.status,
            errorMessage: loginResult.message || 'Official portal requested verification challenge (CAPTCHA/OTP).',
          }, adapter);
          return;
        } else if (
          loginResult.status === 'INVALID_CREDENTIALS' ||
          (loginResult.message && /invalid|password|username/i.test(loginResult.message))
        ) {
          // If password/username is invalid, require credential update without creating new booking records
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
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
              errorMessage: 'Date or route carried after login does not match requested booking.',
            }, adapter);
            return;
          }
        } catch (mismatchErr: any) {
          if (mismatchErr?.message?.includes('MISMATCH')) {
            SanitizedLogger.error(`[BOOKING] Carried date/route mismatch: ${mismatchErr?.message}`);
            BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
            if (typeof adapter.logout === 'function') {
              await adapter.logout().catch(() => { });
            }
            await this.reportFail(job, {
              status: 'TEMPORARY_SLOT_LOST',
              errorCode: mismatchErr?.message?.includes('MISMATCHED_ROUTE') ? 'MISMATCHED_ROUTE' : 'MISMATCHED_DATE',
              errorMessage: mismatchErr?.message || 'Date or route carried after login does not match requested booking.',
            }, adapter);
            return;
          }
          throw mismatchErr;
        }
      }

      // STEP 9 — Select an available slot immediately after login with fallback refreshes (Max 3)
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'SELECTING_SLOT');
      await this.reportProgress(job, 'SELECTING_SLOT', `Selecting time slot for ${canonicalDate}`);

      let postLoginSlotResult: any;
      try {
        postLoginSlotResult = typeof (adapter as any).selectPostLoginSlotWithRefreshFallback === 'function'
          ? await adapter.selectPostLoginSlotWithRefreshFallback(ctx, 3)
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
          SanitizedLogger.warn(`[BOOKING] Slot unavailable or missing cards. Logging out and returning to darshanAvailability to resume monitoring.`);
          if (typeof adapter.logout === 'function') {
            await adapter.logout().catch(() => { });
          }
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'TEMPORARY_SLOT_LOST');
          await this.reportFail(job, {
            status: 'TEMPORARY_SLOT_LOST',
            errorCode: isCardsMissing ? 'SLOT_CARDS_MISSING' : 'SLOT_UNAVAILABLE',
            errorMessage: slotErr?.message || 'All slots unavailable after refresh attempts. Logged out and returned to monitoring.',
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

      const rawPilgrims = Array.isArray(job.pilgrims) && job.pilgrims.length > 0 ? job.pilgrims : [];
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
          const isConfirmed =
            meta.taskStatus === 'CONFIRMED' ||
            meta.status === 'CONFIRMED' ||
            !!meta.officialBookingReference ||
            !!meta.transactionId;
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
            status: isConfirmed ? 'CONFIRMED' : 'PENDING',
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

      const confirmedTasks = pilgrimTasks.filter((t) => t.status === 'CONFIRMED');
      const pendingTasks = pilgrimTasks.filter((t) => t.status !== 'CONFIRMED');
      const previouslyConfirmedCount = confirmedTasks.length;

      const excludedFingerprints = new Set<string>(ctx.excludedPilgrimFingerprints || []);
      for (const ct of confirmedTasks) {
        if (ct.fingerprint) {
          excludedFingerprints.add(ct.fingerprint);
        }
      }

      if (pendingTasks.length === 0) {
        SanitizedLogger.info(
          `[SEQUENTIAL-BOOKING] All ${totalPilgrimCount} devotees already confirmed for Booking #${job.bookingCode}. Completing job.`,
        );
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_CONFIRMED');
        return;
      }

      // Mandatory requirement: Book devotees ONE AT A TIME per availability cycle.
      // Process exactly the next pending devotee, then exit and return to availability watching.
      const currentTask = pendingTasks[0];
      const currentPilgrimNum = currentTask.taskIndex;

      // Required structured log:
      SanitizedLogger.info(
        `[SEQUENTIAL-BOOKING]\nbookingId=${job.bookingCode}\nrequestedCount=${totalPilgrimCount}\nconfirmedCount=${previouslyConfirmedCount}\npendingCount=${pendingTasks.length}\nnextDevoteeSequence=${currentPilgrimNum}\nnextDevoteeName=${currentTask.fullName}`,
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
        await adapter.addToWishlistAndVerify(ctx);
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

        let bookingRef = confirmResult?.officialBookingReference || confirmResult?.officialReference;
        confirmedBookingRef = bookingRef;
        let isCartId = !!(bookingRef && ctx.cartId && bookingRef === ctx.cartId);
        let isValidExternalRef =
          bookingRef &&
          typeof bookingRef === 'string' &&
          bookingRef.trim().length >= 6 &&
          !bookingRef.startsWith('SAB-2026-') &&
          !isCartId;

        if (!confirmResult?.confirmed || !isValidExternalRef) {
          SanitizedLogger.warn(
            `[RECONCILIATION] Devotee #${currentPilgrimNum} unconfirmed on submission. Performing authoritative history reconciliation...`,
          );
          const postHist: any = typeof adapter.checkExistingBookingInHistory === 'function'
            ? await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false }))
            : { found: false };

          if (postHist?.found && postHist?.officialReference && postHist.status !== 'CANCELLED') {
            bookingRef = postHist.officialReference;
            isValidExternalRef = true;
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

        // Report single devotee completion to API
        await this.reportComplete(job, {
          officialReference: bookingRef,
          officialBookingReference: bookingRef,
          cartId: confirmResult.cartId || ctx.cartId,
          portalTransactionReference: confirmResult.portalTransactionReference,
          officialReceiptReference: confirmResult.officialReceiptReference,
          confirmedAt: confirmResult.confirmedAt || new Date().toISOString(),
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

        if (
          errCode === 'PREVIOUS_BOOKING_RESTRICTION' ||
          pilgrimErr?.status === 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED' ||
          errMsg.includes('PREVIOUS_BOOKING_RESTRICTION') ||
          errMsg.includes('previous booking')
        ) {
          failureStatus = 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED';
          failureCode = 'PREVIOUS_BOOKING_RESTRICTION';
        } else if (errCode === 'LOADER_TIMEOUT' || errMsg.includes('LOADER_TIMEOUT')) {
          failureStatus = 'LOADER_TIMEOUT';
          failureCode = 'LOADER_TIMEOUT';
        } else if (
          errCode === 'WISHLIST_MISMATCH' ||
          errCode === 'WISHLIST_VERIFICATION_MISMATCH' ||
          errMsg.includes('WISHLIST_MISMATCH') ||
          errMsg.includes('WISHLIST_VERIFICATION_MISMATCH')
        ) {
          failureStatus = 'WISHLIST_MISMATCH';
          failureCode = 'WISHLIST_MISMATCH';
        } else if (
          errCode === 'WISHLIST_DRAWER_NOT_FOUND' ||
          errMsg.includes('WISHLIST_DRAWER_NOT_FOUND') ||
          pilgrimErr?.status === 'TEMPORARY_SLOT_LOST' ||
          errMsg.includes('SLOT_UNAVAILABLE')
        ) {
          failureStatus = 'TEMPORARY_SLOT_LOST';
          failureCode = errCode || (errMsg.includes('SLOT_UNAVAILABLE') ? 'SLOT_UNAVAILABLE' : 'WISHLIST_DRAWER_NOT_FOUND');
        } else if (errMsg.includes('NOMINEE_DETAILS_MISSING') || errCode === 'NOMINEE_DETAILS_MISSING') {
          failureStatus = 'REQUIRES_HUMAN';
          failureCode = 'NOMINEE_DETAILS_MISSING';
        } else if (errMsg.includes('BUTTON_DISABLED') || errCode === 'FORM_VALIDATION_ERROR') {
          failureStatus = 'REQUIRES_HUMAN';
          failureCode = 'FORM_VALIDATION_ERROR';
        } else if (errMsg.includes('RELIEF_FUND') || errCode === 'RELIEF_FUND_ERROR') {
          failureStatus = 'REQUIRES_HUMAN';
          failureCode = 'RELIEF_FUND_ERROR';
        } else if (errMsg.includes('PAYMENT_REQUIRED_OR_AMBIGUOUS') || errCode === 'PAYMENT_REQUIRED_OR_AMBIGUOUS') {
          failureStatus = 'REQUIRES_HUMAN';
          failureCode = 'PAYMENT_REQUIRED_OR_AMBIGUOUS';
        } else if (
          errCode === 'PORTAL_SERVICE_UNAVAILABLE' ||
          pilgrimErr?.status === 'PORTAL_SERVICE_UNAVAILABLE' ||
          errMsg.includes('PORTAL_SERVICE_UNAVAILABLE') ||
          errMsg.includes('Sorry, this service is not available') ||
          errMsg.includes("service through 'My Wishlist'")
        ) {
          failureStatus = 'PORTAL_SERVICE_UNAVAILABLE';
          failureCode = 'PORTAL_SERVICE_UNAVAILABLE';
          BookingExecutionGuard.releaseGlobalPriorityLock();
        }

        BookingExecutionGuard.updateLifecycleState(bookingKey, failureStatus);

        await this.reportFail(job, {
          status: failureStatus,
          errorCode: failureCode,
          errorMessage: pilgrimErr?.message || `Devotee #${currentPilgrimNum} booking execution failed`,
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
        errorCode === 'DATE_NOT_SELECTABLE' ||
        err.errorCode === 'DATE_NOT_SELECTABLE' ||
        err.status === 'TEMPORARY_SLOT_LOST'
      ) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'DATE_NOT_SELECTABLE';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
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
        codeOrMsg.includes('PREVIOUS_BOOKING_RESTRICTION') ||
        codeOrMsg.includes('ACCOUNT_PREVIOUS_BOOKING_RESTRICTED') ||
        codeOrMsg.includes('quota') ||
        codeOrMsg.includes('pending booking')
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
          } as any);
          return;
        }

        // Return to availability waiting/refresh mode: NEVER mark fatal ACCOUNT_PREVIOUS_BOOKING_RESTRICTED
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'PORTAL_RESTRICTION_RETRYABLE';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('NOMINEE_DETAILS_MISSING') || codeOrMsg.includes('NOMINEE_VALIDATION_FAILED') || codeOrMsg.includes('NOMINEE_REQUIRED')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'NOMINEE_DETAILS_MISSING';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
      } else if (codeOrMsg.includes('PILGRIM_SELECTION_FAILED')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'PILGRIM_SELECTION_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
      } else if (codeOrMsg.includes('BUTTON_DISABLED')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'FORM_VALIDATION_ERROR';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
      } else if (codeOrMsg.includes('SLOT_SELECTION_UNVERIFIED') || codeOrMsg.includes('SLOT_SELECTION_FAILED')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'SLOT_SELECTION_UNVERIFIED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('SLOT_UNAVAILABLE')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'SLOT_UNAVAILABLE';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('RELIEF_FUND_UNVERIFIED') || codeOrMsg.includes('RELIEF_FUND_SELECTION_FAILED') || codeOrMsg.includes('RELIEF_FUND_ERROR')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'RELIEF_FUND_ERROR';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
      } else if (codeOrMsg.includes('WISHLIST_DRAWER_NOT_FOUND')) {
        status = 'TEMPORARY_SLOT_LOST';
        errorCode = 'WISHLIST_DRAWER_NOT_FOUND';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
      } else if (codeOrMsg.includes('WISHLIST_MISMATCH') || codeOrMsg.includes('WISHLIST_VERIFICATION_MISMATCH') || codeOrMsg.includes('CHECKOUT_VERIFICATION_MISMATCH')) {
        status = 'WISHLIST_MISMATCH';
        errorCode = 'WISHLIST_MISMATCH';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'WISHLIST_MISMATCH');
      } else if (codeOrMsg.includes('WISHLIST_INSERTION_FAILED')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'WISHLIST_INSERTION_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
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
        status = 'REQUIRES_HUMAN';
        errorCode = 'PRASADAM_VALIDATION_ERROR';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
      } else if (codeOrMsg.includes('ROUTE_SELECTION_MISMATCH')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'ROUTE_SELECTION_MISMATCH';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
      } else if (codeOrMsg.includes('LOADER_TIMEOUT')) {
        status = 'LOADER_TIMEOUT';
        errorCode = 'LOADER_TIMEOUT';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'LOADER_TIMEOUT');
      } else if (codeOrMsg.includes('PAYMENT_PAGE_LOAD_FAILED')) {
        status = 'REQUIRES_HUMAN';
        errorCode = 'PAYMENT_PAGE_LOAD_FAILED';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'MANUAL_REVIEW');
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
      if (activeLock && !['MANUAL_REVIEW', 'RETRYABLE_FAILURE', 'EXECUTION_FAILED', 'COMPLETED', 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED', 'WISHLIST_MISMATCH', 'LOADER_TIMEOUT', 'BOOKING_CONFIRMED'].includes(activeLock.lifecycleState)) {
        const fallbackLifecycle = status === 'REQUIRES_HUMAN' ? 'MANUAL_REVIEW' : (status || 'RETRYABLE_FAILURE');
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
