import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SanitizedLogger } from '../monitoring/logger';
import { PendingCompletionsManager } from '../resilience/pending-completions';

export interface ExecutionLockInfo {
  bookingId: string;
  bookingCode: string;
  jobId: string;
  attemptId: string;
  dispatchSource: string;
  lifecycleState: string;
  owner: string;
  startedAt: number;
}

export interface GlobalPriorityLockInfo {
  demandKey: string;
  bookingId?: string;
  bookingCode?: string;
  date: string;
  route: string;
  attemptCount: number;
  owner: string;
  acquiredAt: number;
  leaseExpiresAt: number;
}

export class BookingExecutionGuard {
  private static locksByBookingId = new Map<string, ExecutionLockInfo>();
  private static locksByBookingCode = new Map<string, ExecutionLockInfo>();
  private static locksByJobId = new Map<string, ExecutionLockInfo>();

  private static globalPriorityLock: GlobalPriorityLockInfo | null = null;
  private static readonly PRIORITY_STATE_FILE = path.join(process.cwd(), '.booking_priority_state.json');

  static {
    // Restore priority lock from disk on process startup if unexpired (production only)
    if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
      BookingExecutionGuard.restorePriorityState();
    }
  }

  /**
   * Atomically acquires an execution lock for a booking.
   * If any execution is already active for this booking ID, booking code, or job ID,
   * the duplicate dispatch is strictly rejected.
   */
  public static acquire(params: {
    bookingId: string;
    bookingCode: string;
    jobId: string;
    dispatchSource: string;
    owner?: string;
  }): { acquired: boolean; attemptId?: string; existingLock?: ExecutionLockInfo } {
    const { bookingId, bookingCode, jobId, dispatchSource, owner = 'LOCAL_WORKER' } = params;

    // Check existing lock across all identifiers
    const existing =
      this.locksByBookingId.get(bookingId) ||
      this.locksByBookingCode.get(bookingCode) ||
      this.locksByJobId.get(jobId);

    if (existing) {
      const elapsedSec = Math.floor((Date.now() - existing.startedAt) / 1000);
      SanitizedLogger.warn(
        `[EXECUTION-GUARD] ⚠️ Rejected duplicate dispatch for Booking #${bookingCode}: ` +
          `[bookingId=${bookingId}, jobId=${jobId}, incomingSource=${dispatchSource}] ` +
          `Already actively executing under [attemptId=${existing.attemptId}, activeJobId=${existing.jobId}, ` +
          `source=${existing.dispatchSource}, state=${existing.lifecycleState}, owner=${existing.owner}, duration=${elapsedSec}s]`,
      );
      return { acquired: false, existingLock: existing };
    }

    // Guard: Block re-booking while a confirmed pass exists in pending completions awaiting server capture
    if (
      (bookingId && PendingCompletionsManager.hasPending(bookingId)) ||
      (bookingCode && PendingCompletionsManager.hasPending(bookingCode)) ||
      (jobId && PendingCompletionsManager.hasPending(jobId))
    ) {
      SanitizedLogger.warn(
        `[EXECUTION-GUARD] ⛔ Rejected dispatch for Booking #${bookingCode}: Confirmed pass exists in pending completions awaiting server reconciliation. Re-booking blocked to prevent duplicate passes.`,
      );
      return { acquired: false };
    }

    const attemptId = `ATT-${randomUUID().slice(0, 8)}`;
    const lock: ExecutionLockInfo = {
      bookingId,
      bookingCode,
      jobId,
      attemptId,
      dispatchSource,
      lifecycleState: 'CLAIMED',
      owner,
      startedAt: Date.now(),
    };

    if (bookingId) this.locksByBookingId.set(bookingId, lock);
    if (bookingCode) this.locksByBookingCode.set(bookingCode, lock);
    if (jobId) this.locksByJobId.set(jobId, lock);

    SanitizedLogger.info(
      `[EXECUTION-GUARD] 🔒 Execution lock ACQUIRED: bookingId=${bookingId}, bookingCode=${bookingCode}, ` +
        `jobId=${jobId}, attemptId=${attemptId}, source=${dispatchSource}, state=CLAIMED, owner=${owner}`,
    );

    return { acquired: true, attemptId };
  }

  /**
   * Updates the current lifecycle state of an active execution
   */
  public static updateLifecycleState(bookingIdOrCode: string, newState: string): void {
    const lock =
      this.locksByBookingId.get(bookingIdOrCode) ||
      this.locksByBookingCode.get(bookingIdOrCode) ||
      this.locksByJobId.get(bookingIdOrCode);

    if (lock) {
      const oldState = lock.lifecycleState;
      lock.lifecycleState = newState;
      SanitizedLogger.info(
        `[EXECUTION-GUARD] 🔄 Lifecycle transition [Booking #${lock.bookingCode} | Attempt ${lock.attemptId}]: ` +
          `${oldState} -> ${newState}`,
      );
    }
  }

  /**
   * Releases the execution lock cleanly
   */
  public static release(bookingIdOrCode: string, jobId?: string): boolean {
    const lock =
      this.locksByBookingId.get(bookingIdOrCode) ||
      this.locksByBookingCode.get(bookingIdOrCode) ||
      (jobId ? this.locksByJobId.get(jobId) : undefined);

    if (!lock) {
      return false;
    }

    if (lock.bookingId) this.locksByBookingId.delete(lock.bookingId);
    if (lock.bookingCode) this.locksByBookingCode.delete(lock.bookingCode);
    if (lock.jobId) this.locksByJobId.delete(lock.jobId);

    const elapsedSec = Math.floor((Date.now() - lock.startedAt) / 1000);
    SanitizedLogger.info(
      `[EXECUTION-GUARD] 🔓 Execution lock RELEASED: bookingId=${lock.bookingId}, bookingCode=${lock.bookingCode}, ` +
        `jobId=${lock.jobId}, attemptId=${lock.attemptId}, finalState=${lock.lifecycleState}, duration=${elapsedSec}s`,
    );
    return true;
  }

  /**
   * Checks whether a booking is currently undergoing active execution
   */
  public static isBookingActive(bookingIdOrCode: string): boolean {
    return (
      this.locksByBookingId.has(bookingIdOrCode) ||
      this.locksByBookingCode.has(bookingIdOrCode) ||
      this.locksByJobId.has(bookingIdOrCode)
    );
  }

  /**
   * Checks whether a booking has confirmed pass pending server reconciliation
   */
  public static isBookingPendingCompletion(bookingIdOrCode: string): boolean {
    return PendingCompletionsManager.hasPending(bookingIdOrCode);
  }

  /**
   * Returns active lock details if present
   */
  public static getActiveLock(bookingIdOrCode: string): ExecutionLockInfo | undefined {
    return (
      this.locksByBookingId.get(bookingIdOrCode) ||
      this.locksByBookingCode.get(bookingIdOrCode) ||
      this.locksByJobId.get(bookingIdOrCode)
    );
  }

  public static getLock(bookingIdOrCode: string): ExecutionLockInfo | undefined {
    return this.getActiveLock(bookingIdOrCode);
  }

  /**
   * Retrieves current lifecycle state for an execution
   */
  public static getLifecycleState(bookingIdOrCode: string): string | undefined {
    const lock = this.getActiveLock(bookingIdOrCode);
    return lock ? lock.lifecycleState : undefined;
  }

  /**
   * Clears all locks (for test isolation)
   */
  public static clearAll(): void {
    this.locksByBookingId.clear();
    this.locksByBookingCode.clear();
    this.locksByJobId.clear();
    this.globalPriorityLock = null;
    this.clearPersistedPriorityState();
    PendingCompletionsManager.clearAll();
  }

  // =========================================================================
  // GLOBAL BOOKING-PRIORITY LOCK & ORCHESTRATION COORDINATION
  // =========================================================================

  /**
   * Atomically acquires the global booking-priority lock for an available booking.
   * While this lock is held, all availability refresh polling for other dates is paused,
   * and starting/processing other pending booking requests is prevented.
   */
  public static acquireGlobalPriorityLock(params: {
    demandKey: string;
    bookingId?: string;
    bookingCode?: string;
    date: string;
    route: string;
    leaseMs?: number;
    owner?: string;
  }): { acquired: boolean; existingLock?: GlobalPriorityLockInfo } {
    const { demandKey, bookingId, bookingCode, date, route, leaseMs = 600000, owner = 'PRIORITY_ORCHESTRATOR' } = params;
    const now = Date.now();

    // Check existing lock and lease validity
    if (this.globalPriorityLock) {
      if (now > this.globalPriorityLock.leaseExpiresAt) {
        SanitizedLogger.warn(
          `[EXECUTION-GUARD] ⚠️ Previous global priority lock for key=${this.globalPriorityLock.demandKey} expired (fencing lease exceeded). Evicting stale lock.`,
        );
        this.globalPriorityLock = null;
      } else if (
        (this.globalPriorityLock.demandKey === demandKey ||
          (bookingId && this.globalPriorityLock.bookingId === bookingId) ||
          (bookingCode && this.globalPriorityLock.bookingCode === bookingCode) ||
          (this.globalPriorityLock.date === date && (this.globalPriorityLock.route === route || !route))) &&
        (this.globalPriorityLock.owner === owner || owner === 'BOOKING_EXECUTION_FLOW')
      ) {
        // Re-entrant renewal for the same active priority booking
        this.globalPriorityLock.leaseExpiresAt = now + leaseMs;
        if (bookingId) this.globalPriorityLock.bookingId = bookingId;
        if (bookingCode) this.globalPriorityLock.bookingCode = bookingCode;
        this.persistPriorityState();
        SanitizedLogger.info(
          `[EXECUTION-GUARD] 🔄 Global priority lock RENEWED for key=${demandKey} (lease extended by ${leaseMs}ms)`,
        );
        return { acquired: true };
      } else {
        SanitizedLogger.warn(
          `[EXECUTION-GUARD] ⛔ Global priority lock busy: Held by key=${this.globalPriorityLock.demandKey} (date=${this.globalPriorityLock.date}, expires in ${Math.round((this.globalPriorityLock.leaseExpiresAt - now) / 1000)}s). Rejected request for key=${demandKey}.`,
        );
        return { acquired: false, existingLock: this.globalPriorityLock };
      }
    }

    this.globalPriorityLock = {
      demandKey,
      bookingId,
      bookingCode,
      date,
      route,
      attemptCount: 1,
      owner,
      acquiredAt: now,
      leaseExpiresAt: now + leaseMs,
    };

    this.persistPriorityState();
    SanitizedLogger.info(
      `[EXECUTION-GUARD] 🚨 GLOBAL BOOKING-PRIORITY LOCK ACQUIRED: key=${demandKey}, date=${date}, route=${route}, bookingId=${bookingId || '-'}, owner=${owner}, leaseMs=${leaseMs}`,
    );

    return { acquired: true };
  }

  /**
   * Releases the global booking-priority lock, allowing background availability polling to resume.
   */
  public static releaseGlobalPriorityLock(demandKeyOrId?: string): boolean {
    if (!this.globalPriorityLock) {
      this.clearPersistedPriorityState();
      return false;
    }

    if (
      demandKeyOrId &&
      this.globalPriorityLock.demandKey !== demandKeyOrId &&
      this.globalPriorityLock.bookingId !== demandKeyOrId &&
      this.globalPriorityLock.bookingCode !== demandKeyOrId &&
      this.globalPriorityLock.date !== demandKeyOrId &&
      !demandKeyOrId.startsWith(this.globalPriorityLock.date) &&
      !this.globalPriorityLock.demandKey.startsWith(demandKeyOrId)
    ) {
      SanitizedLogger.warn(
        `[EXECUTION-GUARD] Attempted to release global priority lock for ${demandKeyOrId}, but active lock belongs to ${this.globalPriorityLock.demandKey}. Ignored.`,
      );
      return false;
    }

    const elapsed = Date.now() - this.globalPriorityLock.acquiredAt;
    SanitizedLogger.info(
      `[EXECUTION-GUARD] 🟢 GLOBAL BOOKING-PRIORITY LOCK RELEASED: key=${this.globalPriorityLock.demandKey}, date=${this.globalPriorityLock.date}, attempts=${this.globalPriorityLock.attemptCount}, activeDurationMs=${elapsed}. Resuming availability monitoring.`,
    );

    this.globalPriorityLock = null;
    this.clearPersistedPriorityState();
    return true;
  }

  /**
   * Returns true if a global booking-priority execution is currently active and unexpired.
   */
  public static isGlobalPriorityActive(): boolean {
    if (!this.globalPriorityLock) {
      return false;
    }

    if (Date.now() > this.globalPriorityLock.leaseExpiresAt) {
      SanitizedLogger.warn(
        `[EXECUTION-GUARD] Global booking-priority lock for key=${this.globalPriorityLock.demandKey} has expired. Auto-releasing.`,
      );
      this.releaseGlobalPriorityLock();
      return false;
    }

    return true;
  }

  /**
   * Returns true if the specified demand key, booking ID, or booking code is the active priority booking.
   */
  public static isPriorityDemandKey(key: string): boolean {
    if (!this.isGlobalPriorityActive() || !this.globalPriorityLock) {
      return false;
    }

    return (
      this.globalPriorityLock.demandKey === key ||
      this.globalPriorityLock.bookingId === key ||
      this.globalPriorityLock.bookingCode === key ||
      this.globalPriorityLock.date === key ||
      key.startsWith(this.globalPriorityLock.date) ||
      this.globalPriorityLock.demandKey.startsWith(key)
    );
  }

  /**
   * Retrieves active global booking-priority lock details
   */
  public static getActivePriorityLock(): GlobalPriorityLockInfo | null {
    if (!this.isGlobalPriorityActive()) {
      return null;
    }
    return this.globalPriorityLock ? { ...this.globalPriorityLock } : null;
  }

  /**
   * Updates the retry attempt counter on the active priority lock
   */
  public static updatePriorityAttempt(attempt: number): void {
    if (this.globalPriorityLock) {
      this.globalPriorityLock.attemptCount = attempt;
      this.persistPriorityState();
      SanitizedLogger.info(
        `[EXECUTION-GUARD] Priority booking attempt counter updated: key=${this.globalPriorityLock.demandKey}, attempt=${attempt}`,
      );
    }
  }

  /**
   * Persists active priority lock state to disk for crash recovery
   */
  private static persistPriorityState(): void {
    try {
      if (!this.globalPriorityLock) {
        this.clearPersistedPriorityState();
        return;
      }
      fs.writeFileSync(this.PRIORITY_STATE_FILE, JSON.stringify(this.globalPriorityLock), 'utf8');
    } catch (err: any) {
      SanitizedLogger.warn(`[EXECUTION-GUARD] Failed to persist priority state to disk: ${err?.message || err}`);
    }
  }

  /**
   * Restores priority lock state from disk on startup
   */
  public static restorePriorityState(): void {
    try {
      if (fs.existsSync(this.PRIORITY_STATE_FILE)) {
        const raw = fs.readFileSync(this.PRIORITY_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.leaseExpiresAt && Date.now() < parsed.leaseExpiresAt) {
          this.globalPriorityLock = parsed;
          SanitizedLogger.info(
            `[EXECUTION-GUARD] 🛡 Restored active priority lock from disk: key=${parsed.demandKey}, date=${parsed.date}, expires in ${Math.round((parsed.leaseExpiresAt - Date.now()) / 1000)}s`,
          );
        } else {
          this.clearPersistedPriorityState();
        }
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[EXECUTION-GUARD] Failed restoring priority state: ${err?.message || err}`);
      this.clearPersistedPriorityState();
    }
  }

  /**
   * Cleans up persisted priority state file
   */
  private static clearPersistedPriorityState(): void {
    try {
      if (fs.existsSync(this.PRIORITY_STATE_FILE)) {
        fs.unlinkSync(this.PRIORITY_STATE_FILE);
      }
    } catch {}
  }
}
