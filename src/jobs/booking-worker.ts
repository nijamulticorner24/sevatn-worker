import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { normalizeDate } from '../sabarimala/virtual-q';
import { CredentialManager } from '../security/credential-manager';
import { SanitizedLogger } from '../monitoring/logger';
import { BookingExecutionContext, SabarimalaPostLoginFlow } from '../sabarimala/post-login-flow';
import { BookingExecutionGuard } from '../security/execution-guard';
import { validateNominee } from '../security/nominee-validator';
import { BookingConfirmationFlow } from '../sabarimala/flows/booking-confirmation.flow';
import { ConfirmMarkerManager } from '../security/confirm-marker';
import { PendingCompletionsManager } from '../resilience/pending-completions';

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
  ) {}

  private async reportProgress(job: BookingJobData, status: string, note?: string, logs?: any) {
    if (job.leaseGeneration === undefined || job.leaseGeneration === null || !job.fencingToken) {
      throw new Error(`LEASE_INCOMPLETE: Missing leaseGeneration or fencingToken on job #${job.id}`);
    }
    return this.apiClient.updateJobProgress(job.id, {
      status,
      note,
      logs,
      leaseGeneration: job.leaseGeneration,
      fencingToken: job.fencingToken,
    });
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
      BookingExecutionGuard.updateLifecycleState(job.bookingRequestId || job.bookingCode || job.id, 'BOOKING_CONFIRMED');
      return res;
    } catch (err: any) {
      SanitizedLogger.warn(`[BOOKING] completeJob API notice for Job #${job.id}: ${err?.message || err}. Real pass reference was confirmed: ${passRef}. Retained in durable pending completions queue for background sync.`);
      BookingExecutionGuard.updateLifecycleState(job.bookingRequestId || job.bookingCode || job.id, 'BOOKING_CONFIRMED');
      return { success: true, needsReview: true, ref: passRef };
    }
  }

  private async reportFail(
    job: BookingJobData,
    payload: { status: string; errorCode?: string; errorMessage?: string; screenshot?: string },
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

    return this.apiClient.failJob(job.id, {
      ...payload,
      screenshot,
      leaseGeneration: job.leaseGeneration,
      fencingToken: job.fencingToken,
    });
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
      pilgrimCount: job.pilgrimCount || (job.pilgrims ? job.pilgrims.length : 1),
      reliefFund: 0,
      accountId: job.account?.id,
      nominee: job.nominee || null,
      nominees: (job as any).nominees || (job.preferences as any)?.nominees || [],
      pilgrims: job.pilgrims || [],
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

    // Availability is verified by the check loop before claiming. Proceed directly to authenticated booking flow.
    const adapter = new PlaywrightSabarimalaAdapter();

    try {
      await adapter.init();

      // STEP A: DIRECT LOGIN NAVIGATION & AUTHENTICATION
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'PROCESSING');
      await this.reportProgress(job, 'PROCESSING', 'Navigating directly to official Sabarimala login');

      const openLoginSuccess = await adapter.openLogin();
      if (!openLoginSuccess) {
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RETRYABLE_FAILURE');
        await this.reportFail(job, {
          status: 'SITE_ERROR',
          errorCode: 'OFFICIAL_SITE_UNAVAILABLE',
          errorMessage: 'Official Sabarimala login portal could not be reached. Will retry safely.',
        }, adapter);
        return;
      }

      // Check credentials before submitting
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

      // Check if a prior CONFIRM_CLICKED marker exists for this booking
      if (ConfirmMarkerManager.hasMarker(job.bookingCode)) {
        SanitizedLogger.info(`[RECONCILIATION] Prior CONFIRM_CLICKED marker found for #${job.bookingCode}. Checking portal booking history first...`);
        const historyCheck: { found: boolean; officialReference?: string; confirmedAt?: string } =
          await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false, officialReference: undefined, confirmedAt: undefined }));
        if (historyCheck && historyCheck.found && historyCheck.officialReference) {
          SanitizedLogger.info(`[RECONCILIATION] Existing pass #${historyCheck.officialReference} verified in portal history. Completing job directly without rebooking.`);
          ConfirmMarkerManager.clearMarker(job.bookingCode);
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_CONFIRMED');
          await this.reportComplete(job, {
            officialReference: historyCheck.officialReference,
            officialBookingReference: historyCheck.officialReference,
            confirmedAt: historyCheck.confirmedAt || new Date().toISOString(),
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
        }
        SanitizedLogger.info(`[RECONCILIATION] No prior pass found in portal history for #${job.bookingCode}. Proceeding with normal booking flow.`);
      }

      // STEP B: HOME AND VIRTUAL-Q NAVIGATION (#/home -> #/darshan)
      await adapter.navigateToHomeAndDarshan(ctx);

      // STEP C: DATE, ROUTE, AND TIME SLOT SELECTION ON #/darshan
      await adapter.selectAuthenticatedDateAndRoute(ctx);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'DATE_VERIFIED');
      await this.reportProgress(job, 'DATE_VERIFIED', `Date verified: ${ctx.requestedDateDisplay || ctx.requestedDate}`);

      BookingExecutionGuard.updateLifecycleState(bookingKey, 'ROUTE_VERIFIED');
      await this.reportProgress(job, 'ROUTE_VERIFIED', `Route verified: ${ctx.requestedRoute}`);

      BookingExecutionGuard.updateLifecycleState(bookingKey, 'SELECTING_SLOT');
      await this.reportProgress(job, 'SELECTING_SLOT', `Selecting time slot for ${canonicalDate}`);
      const postLoginSlotResult = await adapter.selectPostLoginTimeSlot(ctx);
      SanitizedLogger.info(`[BOOKING] Post-login slot selected: ${postLoginSlotResult.selectedSlot}`);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'SLOT_VERIFIED');
      await this.reportProgress(job, 'SLOT_VERIFIED', `Time slot verified: ${postLoginSlotResult.selectedSlot}`);

      await adapter.selectBookingType(ctx);
      adapter.verifyDateTimePreserved(ctx);

      // STEP D: PILGRIM SELECTION
      await this.reportProgress(job, 'SELECTING_EXISTING_PILGRIMS', 'Selecting registered pilgrims from official account');
      await adapter.selectAllExistingPilgrims(ctx);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'PILGRIMS_VERIFIED');
      await this.reportProgress(job, 'PILGRIMS_VERIFIED', `Pilgrims selected: ${ctx.pilgrimCount}`);

      // STEP E: NOMINEE DETAILS AND RELIEF FUND = "NO"
      await this.reportProgress(job, 'POPULATING_NOMINEES', 'Populating nominee details for selected pilgrims');
      await adapter.populateNomineeDetails(ctx);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'NOMINEE_VERIFIED');
      await this.reportProgress(job, 'NOMINEE_VERIFIED', 'Nominee details populated and verified');

      await adapter.handlePrasadamDetails(ctx);

      await this.reportProgress(job, 'SELECTING_RELIEF_FUND_NO', 'Setting "Contribute for Pilgrim Relief fund" to No');
      await adapter.selectReliefFundNo(ctx);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'RELIEF_VERIFIED');
      await this.reportProgress(job, 'RELIEF_VERIFIED', 'Relief fund set to No (₹0 contribution)');

      // STEP F: ADD TO WISHLIST AND VERIFY NEWLY ADDED ITEM
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'ADDING_TO_WISHLIST');
      await this.reportProgress(job, 'ADDING_TO_WISHLIST', 'Adding booking to Wishlist and verifying newly added item');
      await adapter.addToWishlistAndVerify(ctx);

      BookingExecutionGuard.updateLifecycleState(bookingKey, 'WISHLIST_VERIFIED');
      await this.reportProgress(job, 'WISHLIST_VERIFIED', 'Newly added wishlist item verified with date, route, slot, pilgrims and relief fund');

      // STEP G: PROCEED TO CHECKOUT
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'PROCEEDING_TO_CHECKOUT');
      await this.reportProgress(job, 'PROCEEDING_TO_CHECKOUT', 'Proceeding to checkout with loader synchronization');
      await adapter.proceedToPaymentGateway(ctx);

      // STEP H: CHECKOUT VERIFIED (Authoritative comparison of payment page details)
      await adapter.verifyPaymentSummary(ctx);
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'CHECKOUT_VERIFIED');
      await this.reportProgress(job, 'CHECKOUT_VERIFIED', 'Payment review page details independently verified against booking request');

      const rawAmount = ctx.grandTotal || '₹0.00';
      const isZeroCost = BookingConfirmationFlow.parseNumericAmount(rawAmount) === 0;

      if (isZeroCost) {
        if (ctx.allowZeroCostConfirmation === false) {
          SanitizedLogger.warn(`[BOOKING] Customer authorization required for zero-cost confirmation. Pausing.`);
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'REQUIRES_HUMAN');
          await this.reportProgress(job, 'REQUIRES_HUMAN', 'Zero-cost confirmation awaiting customer authorization policy');
          throw new Error('REQUIRES_HUMAN: Zero-cost confirmation awaiting customer authorization policy');
        }
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'ZERO_COST_CONFIRMATION_PENDING');
        await this.reportProgress(job, 'ZERO_COST_CONFIRMATION_PENDING', 'Submitting official zero-cost Virtual-Q confirmation');
      } else {
        if (!ctx.allowPayment) {
          SanitizedLogger.warn(`[BOOKING] Paid booking requires explicit payment authorization: ${rawAmount}. Pausing.`);
          BookingExecutionGuard.updateLifecycleState(bookingKey, 'PAYMENT_PENDING');
          await this.reportProgress(job, 'PAYMENT_PENDING', `Paid booking awaiting customer payment authorization: ${rawAmount}`);
          throw new Error(`PAYMENT_PENDING: Paid booking awaiting customer payment authorization: ${rawAmount}`);
        }
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'PAYMENT_PENDING');
        await this.reportProgress(job, 'PAYMENT_PENDING', `Executing payment transaction for ${rawAmount}`);
      }

      // STEP I: FINAL CONFIRMATION AND COMPLETION
      BookingExecutionGuard.updateLifecycleState(bookingKey, 'CONFIRMATION_PENDING');

      // Send non-blocking progress update before confirmation (failure is logged and ignored)
      await this.reportProgress(job, 'CONFIRMING', 'Submitting confirmation on payment page').catch((progressErr: any) => {
        SanitizedLogger.warn(`[BOOKING] Non-blocking CONFIRMING progress report notice for #${job.bookingCode}: ${progressErr?.message || progressErr}`);
      });

      let confirmResult: any;
      try {
        confirmResult = await adapter.executePaymentProceedAndConfirm(ctx);
      } catch (submitErr: any) {
        SanitizedLogger.warn(`[BOOKING] Submission threw or timed out for #${job.bookingCode}: ${submitErr?.message}. Checking portal booking history before classifying failure...`);
        const historyCheck: { found: boolean; officialReference?: string; confirmedAt?: string } =
          await adapter.checkExistingBookingInHistory(ctx).catch(() => ({ found: false, officialReference: undefined, confirmedAt: undefined }));
        if (historyCheck && historyCheck.found && historyCheck.officialReference) {
          SanitizedLogger.info(`[RECONCILIATION] Submission timed out but pass #${historyCheck.officialReference} was created in portal history! Completing as SUCCESS.`);
          confirmResult = {
            confirmed: true,
            officialReference: historyCheck.officialReference,
            officialBookingReference: historyCheck.officialReference,
            confirmedAt: historyCheck.confirmedAt,
            reconciledFromHistory: true,
          };
        } else {
          throw submitErr;
        }
      }
      const bookingRef = confirmResult.officialBookingReference || confirmResult.officialReference;
      const isCartId = !!(bookingRef && ctx.cartId && bookingRef === ctx.cartId);
      const isValidExternalRef =
        bookingRef &&
        typeof bookingRef === 'string' &&
        bookingRef.trim().length >= 6 &&
        !bookingRef.startsWith('SAB-2026-') &&
        !isCartId;

      if (confirmResult.confirmed && isValidExternalRef) {
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_CONFIRMED');
        await this.reportComplete(job, {
          officialReference: bookingRef,
          officialBookingReference: bookingRef,
          cartId: confirmResult.cartId || ctx.cartId,
          portalTransactionReference: confirmResult.portalTransactionReference,
          officialReceiptReference: confirmResult.officialReceiptReference,
          confirmationEvidence: confirmResult.confirmationEvidence,
          confirmedAt: confirmResult.confirmedAt || new Date().toISOString(),
          confirmationData: confirmResult.confirmationData || {
            officialReference: bookingRef,
            officialBookingReference: bookingRef,
            cartId: confirmResult.cartId || ctx.cartId,
            portalTransactionReference: confirmResult.portalTransactionReference,
            requestedDate: canonicalDate,
            selectedTime: ctx.selectedTimeSlot,
            route: ctx.requestedRoute,
            pilgrimsCount: ctx.pilgrimCount || 1,
            grandTotal: rawAmount,
            timestamp: new Date().toISOString(),
            status: 'CONFIRMED',
          },
          note: `Official Sabarimala Pass confirmed #${bookingRef}`,
        });
      } else if (confirmResult.reconciliationRequired || !isValidExternalRef) {
        SanitizedLogger.warn(`[BOOKING] Outcome unconfirmed or authoritative reference missing for #${job.bookingCode}. Flagging as RECONCILIATION_REQUIRED.`);
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'RECONCILIATION_REQUIRED');
        await this.reportFail(job, {
          status: 'RECONCILIATION_REQUIRED',
          errorCode: 'VERIFICATION_PENDING',
          errorMessage: confirmResult.message || 'Booking submission completed but official confirmation reference could not be authoritatively validated.',
        }, adapter);
        throw new Error(`RECONCILIATION_REQUIRED: ${confirmResult.message || 'Verification pending'}`);
      } else {
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'BOOKING_FAILED');
        await this.reportFail(job, {
          status: 'BOOKING_FAILED',
          errorCode: 'CONFIRMATION_FAILED',
          errorMessage: confirmResult.message || 'Official portal did not confirm reservation.',
        }, adapter);
        throw new Error(`BOOKING_FAILED: ${confirmResult.message || 'Confirmation failed'}`);
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

      let status = 'WORKER_ERROR';
      let errorCode = err.code || 'EXECUTION_EXCEPTION';
      const codeOrMsg = (err.code || '') + ' ' + (err.message || '');
      const statusCode = err?.response?.status || err?.status;

      if (codeOrMsg.includes('LEASE_LOST_RECOVERABLE')) {
        status = 'RETRYABLE_FAILURE';
        errorCode = 'LEASE_LOST_RECOVERABLE';
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
      } else if (codeOrMsg.includes('PREVIOUS_BOOKING_RESTRICTION') || codeOrMsg.includes('ACCOUNT_PREVIOUS_BOOKING_RESTRICTED')) {
        status = 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED';
        errorCode = 'PREVIOUS_BOOKING_RESTRICTION';
        BookingExecutionGuard.updateLifecycleState(bookingKey, 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED');
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
        } catch {}
      }

      await this.reportFail(job, {
        status,
        errorCode,
        errorMessage: err.message || 'Unexpected error communicating with official portal.',
        screenshot,
      }, adapter).catch((reportErr) => {
        SanitizedLogger.warn(`[BOOKING] Failed to report failure to backend: ${reportErr?.message || reportErr}`);
      });
    } finally {
      if (internalLockAcquired) {
        BookingExecutionGuard.release(bookingKey, job.id);
      }
      await adapter.close().catch(() => {});
    }
  }
}
