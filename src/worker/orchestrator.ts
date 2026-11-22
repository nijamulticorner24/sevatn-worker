import { ApiClient } from '../api/client';
import { HeartbeatService } from '../heartbeat/heartbeat';
import { VerificationWorker } from '../jobs/verification-worker';
import { BookingWorker } from '../jobs/booking-worker';
import { AvailabilityDiscoveryWorker } from '../availability/discovery-worker';
import { SanitizedLogger } from '../monitoring/logger';
import { BookingExecutionGuard } from '../security/execution-guard';
import { PendingCompletionsManager } from '../resilience/pending-completions';
import { AvailabilityCache } from '../availability/availability-cache';
import { normalizeDate } from '../sabarimala/virtual-q';
import { normalizeDemandKey, parseDemandKey } from '../availability/demand-key';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';

export { parseDemandKey } from '../availability/demand-key';

// Q6/ITEM 8: Arbiter lease renewal timing (PR #0)
export const LEASE_RENEWAL_MS = Number(process.env.LEASE_RENEWAL_MS ?? 10000);

// PR #4 Patch: Slot opened debounce threshold (default 5000ms)
export const SLOT_OPEN_DEBOUNCE_MS = Number(process.env.SLOT_OPEN_DEBOUNCE_MS ?? 5000);

// Base availability discovery cadence & jitter
export const AVAILABILITY_POLL_INTERVAL_MS = Number(
  process.env.AVAILABILITY_POLL_INTERVAL_MS
    ?? process.env.DISCOVERY_INTERVAL_MS
    ?? 8000
);
export const AVAILABILITY_POLL_JITTER_MS = Number(process.env.AVAILABILITY_POLL_JITTER_MS ?? 4000);

// State machine window durations & controls
export const WATCH_WINDOW_MS = Number(process.env.WATCH_WINDOW_MS ?? 600000);
export const REST_WINDOW_MS = Number(process.env.REST_WINDOW_MS ?? 60000);
export const REST_ENTRY_CHECK = process.env.REST_ENTRY_CHECK !== 'false';
export const REST_EXIT_CHECK = process.env.REST_EXIT_CHECK !== 'false';

export type Phase = 'CHECKING' | 'WATCHING' | 'RESTING' | 'BOOKING' | 'COMPLETING';

export interface DemandKeyState {
  demandKey: string;              // `${date}:${route}` or `${date}|${route}`
  phase: Phase;
  watchStartedAt: number;         // ms epoch
  restUntil?: number;             // ms epoch
  bookingIds: string[];           // bookings currently WATCHING on this key
  pollSeq: number;
  inFlight: boolean;              // guard against overlapping polls/book flows
  lastPollStartedAt?: number;     // ms epoch when last poll began
  lastPolledAt?: number;          // ms epoch
  nextPollAt?: number;            // ms epoch when next poll is due (scheduled from poll START)
  lastState?: string;
  firstRestTick?: boolean;
}

export class WorkerOrchestrator {
  private isRunning = false;
  private verificationWorker: VerificationWorker;
  private bookingWorker: BookingWorker;
  private discoveryWorker: AvailabilityDiscoveryWorker;

  private maxActiveBookings: number;
  private maxAvailabilityMonitors: number;
  private activeExecutions = 0;
  private activeJobIds = new Set<string>();

  // Single-Engine State Machine per demand key
  private keyStates: Map<string, DemandKeyState> = new Map();

  // PR #4 Patch: Track the last slot:opened timestamp per date|route
  private lastSlotOpenedMap: Map<string, number> = new Map<string, number>();
  private localPendingJobs: Array<{ date: string; route?: string }> = [];

  // Verification background task loop handle
  private verificationLoopTimer: NodeJS.Timeout | null = null;

  // Persistent discovery browser context and recycling management
  private persistentDiscoveryAdapter: PlaywrightSabarimalaAdapter | null = null;
  private discoveryPassesSinceRecycle: number = 0;
  private discoveryRecycleLimit: number = 500;

  constructor(
    private apiClient: ApiClient,
    private heartbeat: HeartbeatService,
    private checkIntervalMs: number = 250,
    private discoveryIntervalMs: number = Number(process.env.AVAILABILITY_POLL_INTERVAL_MS ?? process.env.DISCOVERY_INTERVAL_MS ?? 8000),
    private slotOpenDebounceMs: number = Number(process.env.SLOT_OPEN_DEBOUNCE_MS ?? 5000),
    private cache: AvailabilityCache = AvailabilityCache.getInstance(),
  ) {
    this.verificationWorker = new VerificationWorker(apiClient);
    this.bookingWorker = new BookingWorker(apiClient, this.cache);
    this.discoveryWorker = new AvailabilityDiscoveryWorker(
      apiClient,
      (jobType: string, job: any) => {
        this.dispatchSnipedJob(jobType, job);
      },
      this.cache,
      () => Array.from(this.activeJobIds),
    );

    // Event listener: if discovery worker emits slot:opened, trigger immediate booking on this engine
    this.discoveryWorker.on('slot:opened', async (payload: { date: string; route: string }) => {
      await this.handleSlotOpened(payload.date, payload.route);
    });

    this.maxActiveBookings = parseInt(process.env.MAX_ACTIVE_BOOKINGS || '3', 10);
    this.maxAvailabilityMonitors = parseInt(process.env.MAX_AVAILABILITY_MONITORS || '2', 10);
    this.discoveryRecycleLimit = Number(process.env.DISCOVERY_CONTEXT_RECYCLE_POLLS ?? 500);
  }

  /**
   * Reuses a persistent discovery context across polls, navigating/reloading the same
   * darshanAvailability page, and recycling the context every DISCOVERY_CONTEXT_RECYCLE_POLLS passes.
   */
  public async ensureDiscoveryAdapter(): Promise<PlaywrightSabarimalaAdapter> {
    this.discoveryRecycleLimit = Number(process.env.DISCOVERY_CONTEXT_RECYCLE_POLLS ?? 500);
    this.discoveryPassesSinceRecycle++;

    const page = this.persistentDiscoveryAdapter?.getPage();
    const isAlive =
      this.persistentDiscoveryAdapter !== null &&
      page !== null &&
      page !== undefined &&
      typeof page.isClosed === 'function' &&
      !page.isClosed();

    if (!isAlive || this.discoveryPassesSinceRecycle >= this.discoveryRecycleLimit) {
      if (this.persistentDiscoveryAdapter) {
        await this.persistentDiscoveryAdapter.close().catch(() => {});
        SanitizedLogger.info(`[DISCOVERY] Context recycled after ${this.discoveryPassesSinceRecycle} passes`);
      }
      this.persistentDiscoveryAdapter = new PlaywrightSabarimalaAdapter();
      await this.persistentDiscoveryAdapter.init();
      // Pre-navigate to darshanAvailability once per recycled context
      await this.persistentDiscoveryAdapter.openDarshanAvailability().catch(() => {});
      this.discoveryPassesSinceRecycle = 0;
    }

    return this.persistentDiscoveryAdapter;
  }

  async start() {
    this.isRunning = true;
    SanitizedLogger.info('=======================================================');
    SanitizedLogger.info('🚀 TICKETASSIST SINGLE-ENGINE AUTONOMOUS STATE MACHINE STARTED');
    SanitizedLogger.info(`• Unified Engine: Continuous WATCHING -> RESTING -> BOOKING -> COMPLETING`);
    SanitizedLogger.info(`• Concurrency Limit: ${this.maxActiveBookings}`);
    SanitizedLogger.info(`• Watch Window: ${WATCH_WINDOW_MS}ms | Rest Window: ${REST_WINDOW_MS}ms`);
    SanitizedLogger.info(`• Verification: Independent Sandboxed Background Task`);
    SanitizedLogger.info('=======================================================');

    // Resume pending completion persistence & background retry loop
    PendingCompletionsManager.init(this.apiClient);

    // Boot: Pre-warm persistent Chromium browser and discovery context ONCE at boot
    if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
      try {
        await this.ensureDiscoveryAdapter();
      } catch (err: any) {
        SanitizedLogger.warn('[WORKER] Notice during boot discovery context pre-warm:', err.message || err);
      }
    }

    // Start background account verification task (never blocks main loop)
    this.startBackgroundVerificationTask();

    // Start single continuous autonomous engine loop
    this.startSingleEngineLoop();
  }

  stop() {
    this.isRunning = false;
    if (this.verificationLoopTimer) {
      clearInterval(this.verificationLoopTimer);
      this.verificationLoopTimer = null;
    }
    PendingCompletionsManager.stopRetryLoop();
    SanitizedLogger.info('[Worker] Stopping single engine loops...');
    if (this.persistentDiscoveryAdapter) {
      this.persistentDiscoveryAdapter.close().catch(() => {});
      this.persistentDiscoveryAdapter = null;
      this.discoveryPassesSinceRecycle = 0;
    }
    if (this.discoveryWorker && typeof this.discoveryWorker.shutdown === 'function') {
      this.discoveryWorker.shutdown().catch(() => {});
    }
  }

  /**
   * Helper: parses canonical date and route from a demandKey
   */
  private parseDemandKey(key: string): { date: string; route: string; criteria?: string } {
    return parseDemandKey(key);
  }

  /**
   * Derives and synchronizes active demand keys from the central database every tick.
   * Enforces no-dead invariant: while any booking is in WATCHING, its demand key is in the watch set.
   * Resilient against transient network, auth (401), server (500) or timeout errors:
   * existing active monitoring state is NEVER wiped out due to API failures.
   */
  private async syncWatchSetFromDb(now: number): Promise<void> {
    try {
      let demandGroups: any[] = [];
      let isAuthoritativeResponse = false;
      let lastSyncError: any = null;

      // 1. Try primary endpoint: /availability/demand-dates
      if (typeof this.apiClient.getDemandDates === 'function') {
        try {
          const res = await this.apiClient.getDemandDates();
          if (Array.isArray(res)) {
            demandGroups = res;
            isAuthoritativeResponse = true;
          }
        } catch (err: any) {
          lastSyncError = err;
          const status = err?.response?.status;
          SanitizedLogger.warn(
            `[WORKER] Primary demand-dates sync failed (status=${status || 'network/timeout'}): ${err?.message || err}`
          );
        }
      }

      // 2. Supplementary fallback: /workers/pending-dates if primary is empty
      if ((!demandGroups || demandGroups.length === 0) && typeof this.apiClient.getPendingDates === 'function') {
        try {
          const pending = await this.apiClient.getPendingDates();
          if (pending && Array.isArray(pending.dates)) {
            isAuthoritativeResponse = true;
            if (pending.dates.length > 0) {
              demandGroups = pending.dates.map((d: string) => ({
                date: d,
                route: 'Pamba (Regular Footpath Route)',
                pendingCount: 1,
              }));
            }
          }
        } catch (err: any) {
          const status = err?.response?.status;
          SanitizedLogger.warn(
            `[WORKER] Fallback pending-dates sync failed (status=${status || 'network/timeout'}): ${err?.message || err}`
          );
          // If fallback was invoked because primary demand was empty, but fallback failed with an error,
          // we cannot authoritatively conclude that demands are empty.
          isAuthoritativeResponse = false;
          lastSyncError = err;
        }
      }

      // 3. Resilience check: If sync failed (e.g. 401, 500, timeout, network error) and no endpoint succeeded,
      // PRESERVE the existing active monitoring set. Never treat an API failure as an empty demand list.
      if (!isAuthoritativeResponse) {
        SanitizedLogger.warn(
          `[WORKER] API demand sync failed; preserving existing monitoring set (${this.keyStates.size} active keys). Reason: ${lastSyncError?.message || 'Unreachable'}`
        );
        return;
      }

      // Include registered retryable demands
      if (this.discoveryWorker?.retryableDemands) {
        for (const [key, retryable] of this.discoveryWorker.retryableDemands.entries()) {
          const canonical = normalizeDate(retryable.date);
          const exists = demandGroups.some((d) => normalizeDate(d.date) === canonical);
          if (!exists) {
            demandGroups.push({
              demandKey: key,
              date: canonical,
              route: retryable.route,
              pendingCount: 1,
            });
          }
        }
      }

      // Include local pending jobs (used in test harnesses)
      if (this.localPendingJobs && this.localPendingJobs.length > 0) {
        for (const job of this.localPendingJobs) {
          const canonical = normalizeDate(job.date);
          const r = job.route || 'Pamba (Regular Footpath Route)';
          const k = normalizeDemandKey(canonical, r);
          const exists = demandGroups.some((d) => (d.demandKey || normalizeDemandKey(d.date, d.route)) === k);
          if (!exists) {
            demandGroups.push({
              demandKey: k,
              date: canonical,
              route: r,
              pendingCount: 1,
            });
          }
        }
      }

      const activeKeysInDb = new Set<string>();

      for (const group of demandGroups) {
        const key = group.demandKey || normalizeDemandKey(group.date, group.route);
        activeKeysInDb.add(key);

        let state = this.keyStates.get(key);
        if (!state) {
          state = {
            demandKey: key,
            phase: 'WATCHING',
            watchStartedAt: now,
            bookingIds: group.bookingIds || (group.bookingCode ? [group.bookingCode] : [key]),
            pollSeq: 0,
            inFlight: false,
            firstRestTick: false,
          };
          this.keyStates.set(key, state);
          SanitizedLogger.info(`[WORKER] key=${key} step=WATCHING watchAgeMs=0 restRemainingMs=- state=- pollSeq=0 bookingIds=${state.bookingIds.join(',')} -> added to watch set`);
        } else {
          // Update bookingIds without overwriting phase if already set (e.g. RESTING)
          if (group.bookingIds && Array.isArray(group.bookingIds) && group.bookingIds.length > 0) {
            state.bookingIds = group.bookingIds;
          }
        }
      }

      // Check invariant: if active bookings exist in DB but watch set is empty, force rebuild immediately
      const totalPendingCount = demandGroups.reduce((acc, g) => acc + (g.pendingCount || 1), 0);
      if (this.keyStates.size === 0 && totalPendingCount > 0) {
        SanitizedLogger.warn(`[WORKER] watch set empty but ${totalPendingCount} watching bookings exist — forcing rebuild`);
        for (const group of demandGroups) {
          const key = group.demandKey || normalizeDemandKey(group.date, group.route);
          this.keyStates.set(key, {
            demandKey: key,
            phase: 'WATCHING',
            watchStartedAt: now,
            bookingIds: group.bookingIds || [key],
            pollSeq: 0,
            inFlight: false,
          });
        }
      }

      // Authoritative cleanup: ONLY prune keys when we have a successful authoritative response from the DB
      for (const [key, state] of this.keyStates.entries()) {
        if (!activeKeysInDb.has(key) && state.phase !== 'BOOKING' && !state.inFlight) {
          this.keyStates.delete(key);
        }
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[WORKER] Failed to synchronize watch set from DB: ${err.message || err}`);
    }
  }

  /**
   * The Single Continuous Engine Loop: executes one tick every 250-1000ms.
   * Governs WATCHING, RESTING, BOOKING, and COMPLETING state machine for all demand keys.
   */
  private async startSingleEngineLoop() {
    SanitizedLogger.info('[WORKER] Single-engine continuous autonomous state machine initialized.');

    // Per-worker boot offset
    const bootOffset = Math.floor(Math.random() * Math.min(2000, this.checkIntervalMs));
    await this.sleep(bootOffset);

    let lastActiveKeysLog = '';
    let lastActiveKeysLogAt = 0;

    while (this.isRunning) {
      const now = Date.now();

      // Check Super Admin desired state / permissions
      const executionPermitted = typeof this.heartbeat?.isExecutionPermitted === 'function' ? this.heartbeat.isExecutionPermitted() : true;
      const discoveryPermitted = typeof this.heartbeat?.isDiscoveryPermitted === 'function' ? this.heartbeat.isDiscoveryPermitted() : executionPermitted;

      if (!executionPermitted && !discoveryPermitted) {
        if (this.activeExecutions === 0) {
          this.heartbeat?.setStatus?.('IDLE');
        }
        await this.sleep(Math.max(1000, this.checkIntervalMs));
        continue;
      }

      // 1. Sync active watch set from database
      await this.syncWatchSetFromDb(now);

      // Log active check keys on key change OR every 10s heartbeat
      const activeKeys = Array.from(this.keyStates.keys());
      const activeKeysStr = activeKeys.join(',');
      if (activeKeysStr !== lastActiveKeysLog || (now - lastActiveKeysLogAt) >= 10000) {
        SanitizedLogger.info(`[WORKER] active check keys=[${activeKeysStr}]`);
        lastActiveKeysLog = activeKeysStr;
        lastActiveKeysLogAt = now;
      }

      // 2. Process all demand keys in the state machine
      for (const [key, state] of this.keyStates.entries()) {
        await this.tickDemandKey(key, state, now);
      }

      // 3. Queue poll fallback when watch set is empty or idle (strictly non-booking jobs only)
      if (this.keyStates.size === 0 && this.activeExecutions < this.maxActiveBookings && this.heartbeat.isExecutionPermitted()) {
        await this.pollUnscheduledJobQueue();
      }

      // Dynamic wake-up: calculate time until earliest key's next poll is due so the poll fires within ~50ms of nextPollAt
      let minSleep = this.checkIntervalMs;
      for (const state of this.keyStates.values()) {
        if (state.phase === 'WATCHING' && state.nextPollAt && !state.inFlight) {
          const untilPoll = state.nextPollAt - Date.now();
          if (untilPoll > 0 && untilPoll < minSleep) {
            minSleep = untilPoll;
          }
        }
      }

      await this.sleep(Math.max(10, minSleep));
    }
  }

  /**
   * Ticks a single demand key through the 4-phase state machine
   */
  private async tickDemandKey(key: string, state: DemandKeyState, now: number): Promise<void> {
    if (state.inFlight) {
      // Guard against overlapping operations for this key
      return;
    }

    const { date, route } = this.parseDemandKey(key);
    const watchAgeMs = now - state.watchStartedAt;
    const restRemainingMs = state.restUntil ? Math.max(0, state.restUntil - now) : 0;
    const bookingIdsStr = state.bookingIds.join(',') || key;

    // ==========================================
    // PHASE 1: WATCHING
    // ==========================================
    if (state.phase === 'WATCHING') {
      // 1. Check No-Dead Invariant enforcement:
      // If now - lastPollStartedAt > 15000ms for a WATCHING key, immediately trigger a poll in the same tick
      let forcedPoll = false;
      const lastStart = state.lastPollStartedAt ?? state.lastPolledAt;
      if (lastStart && (now - lastStart) > 15000) {
        SanitizedLogger.error(`[WORKER] no-dead invariant violated key=${key} lastPolledAgo=${now - lastStart}ms`);
        SanitizedLogger.warn(`[WORKER] no-dead ENFORCED key=${key} forcedPoll=true`);
        forcedPoll = true;
      }

      // 2. Check if watch window expired -> transition to RESTING
      if (watchAgeMs >= WATCH_WINDOW_MS) {
        state.phase = 'RESTING';
        state.restUntil = now + REST_WINDOW_MS;
        state.firstRestTick = true;
        SanitizedLogger.info(
          `[WORKER] key=${key} step=RESTING watchAgeMs=${watchAgeMs} restRemainingMs=${REST_WINDOW_MS} state=- pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr} transition=WATCHING->RESTING reason=WATCH_WINDOW_EXPIRED(${WATCH_WINDOW_MS}ms)`
        );
        return;
      }

      // 3. Validation: malformed date must abort the poll, log ERROR and set state=ERROR (never UNKNOWN)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const rawDate = (key.includes(':') ? key.split(':')[0] : key.split('|')[0]) || key;
        SanitizedLogger.error(`[DISCOVERY] invalid date input raw=${rawDate} parsed=${date} key=${key}`);
        state.lastState = 'ERROR';
        SanitizedLogger.info(
          `[WORKER] key=${key} step=WATCHING watchAgeMs=${watchAgeMs} restRemainingMs=- state=ERROR pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr}`
        );
        return;
      }

      // 4. Cadence check:
      // nextPollAt is scheduled from poll START time, not poll COMPLETION time
      const isDueForPoll = forcedPoll || !state.nextPollAt || now >= state.nextPollAt;

      if (!isDueForPoll) {
        // Emit tick progress log at most once every 5000ms to avoid flooding stdout during sub-second ticks
        const lastLog = (state as any).lastTickLogAt ?? 0;
        if (state.pollSeq === 0 || (now - lastLog) >= 5000) {
          (state as any).lastTickLogAt = now;
          SanitizedLogger.info(
            `[WORKER] key=${key} step=WATCHING watchAgeMs=${watchAgeMs} restRemainingMs=- state=${state.lastState || '-'} pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr}`
          );
        }
        return;
      }

      // 5. Trigger availability poll
      state.inFlight = true;
      state.pollSeq++;
      const pollStartedAt = now;
      state.lastPollStartedAt = pollStartedAt;
      state.lastPolledAt = pollStartedAt;

      SanitizedLogger.info(`[POLL] start key=${key} ts=${pollStartedAt} seq=${state.pollSeq}`);

      try {
        const checkResult = await this.pollAvailabilityForDate(key, date, route);
        const realDurationMs = Date.now() - pollStartedAt;
        const pollDurationMs = (pollStartedAt > 1000000000000 && realDurationMs >= 0 && realDurationMs <= 120000)
          ? realDurationMs
          : 0;
        state.lastState = checkResult.state;

        SanitizedLogger.info(`[POLL] end key=${key} durationMs=${pollDurationMs} state=${checkResult.state}`);
        SanitizedLogger.info(
          `[WORKER] key=${key} state=${checkResult.state} pollSeq=${state.pollSeq} watchAgeMs=${Date.now() - state.watchStartedAt}`
        );
        SanitizedLogger.info(
          `[WORKER] key=${key} step=CHECKING state=${checkResult.state} watchAgeMs=${Date.now() - state.watchStartedAt} restRemainingMs=- pollSeq=${state.pollSeq} pollStartTs=${pollStartedAt} pollDurationMs=${pollDurationMs}`
        );
        SanitizedLogger.info(
          `[WORKER] key=${key} step=WATCHING watchAgeMs=${Date.now() - state.watchStartedAt} restRemainingMs=- state=${checkResult.state} pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr}`
        );

        // Schedule next poll from poll START time:
        // nextPollAt = pollStartTs + 8000 + Math.floor(Math.random() * 4000)
        // If pollDuration > interval, start next poll immediately (nextPollAt = now)
        const baseInterval = Number(process.env.AVAILABILITY_POLL_INTERVAL_MS ?? AVAILABILITY_POLL_INTERVAL_MS ?? 8000);
        const jitterConfig = Number(process.env.AVAILABILITY_POLL_JITTER_MS ?? AVAILABILITY_POLL_JITTER_MS ?? 4000);
        const jitterMs = jitterConfig > 0 ? Math.floor(Math.random() * jitterConfig) : 0;
        const intervalMs = baseInterval + jitterMs;

        if (pollDurationMs > intervalMs) {
          state.nextPollAt = Date.now();
        } else {
          state.nextPollAt = pollStartedAt + intervalMs;
        }

        if (checkResult.state === 'AVAILABLE') {
          // NO HANDOFF INVARIANT: Transition WATCHING -> BOOKING occurs in the same tick handler!
          SanitizedLogger.info(
            `[WORKER] key=${key} step=BOOKING watchAgeMs=${Date.now() - state.watchStartedAt} restRemainingMs=- state=AVAILABLE pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr} transition=WATCHING->BOOKING reason=SLOT_AVAILABLE_NO_HANDOFF`
          );
          SanitizedLogger.info(`[WORKER] key=${key} AVAILABLE -> BOOKING`);
          state.phase = 'BOOKING';
          // Multi-key independence: launch booking flow without blocking tick loop for other keys
          this.executeBookingFlow(key, state, date, route)
            .catch((err) => SanitizedLogger.error(`[WORKER] key=${key} booking flow error:`, err))
            .finally(() => {
              if (state.phase !== 'BOOKING') {
                state.inFlight = false;
              }
            });
          return;
        }
      } catch (err: any) {
        state.lastState = 'ERROR';
        SanitizedLogger.warn(`[WORKER] key=${key} step=WATCHING poll error: ${err.message || err}`);
        const pollDurationMs = Date.now() - pollStartedAt;
        const baseInterval = Number(process.env.AVAILABILITY_POLL_INTERVAL_MS ?? AVAILABILITY_POLL_INTERVAL_MS ?? 8000);
        const jitterConfig = Number(process.env.AVAILABILITY_POLL_JITTER_MS ?? AVAILABILITY_POLL_JITTER_MS ?? 4000);
        const jitterMs = jitterConfig > 0 ? Math.floor(Math.random() * jitterConfig) : 0;
        const intervalMs = baseInterval + jitterMs;

        if (pollDurationMs > intervalMs) {
          state.nextPollAt = Date.now();
        } else {
          state.nextPollAt = pollStartedAt + intervalMs;
        }
      } finally {
        if (state.phase !== 'BOOKING') {
          state.inFlight = false;
        }
      }
      return;
    }

    // ==========================================
    // PHASE 2: RESTING
    // ==========================================
    if (state.phase === 'RESTING') {
      if (now < (state.restUntil ?? 0)) {
        // Still in rest window: NO browser navigation
        if (REST_ENTRY_CHECK && state.firstRestTick) {
          state.firstRestTick = false;
          // Cache-first availability check
          const cacheKey = AvailabilityCache.buildKey(date, route);
          const cached = this.cache.get(cacheKey, 15000);
          if (cached && cached.state === 'AVAILABLE') {
            SanitizedLogger.info(
              `[WORKER] key=${key} step=BOOKING watchAgeMs=${watchAgeMs} restRemainingMs=${restRemainingMs} state=AVAILABLE pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr} transition=RESTING->BOOKING reason=REST_ENTRY_CHECK_AVAILABLE`
            );
            state.phase = 'BOOKING';
            state.inFlight = true;
            try {
              await this.executeBookingFlow(key, state, date, route);
            } finally {
              state.inFlight = false;
            }
            return;
          }
        }

        SanitizedLogger.info(
          `[WORKER] key=${key} step=RESTING watchAgeMs=${watchAgeMs} restRemainingMs=${restRemainingMs} state=${state.lastState || '-'} pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr}`
        );
        return;
      }

      // Rest window completed (now >= restUntil)
      SanitizedLogger.info(
        `[WORKER] key=${key} step=RESTING watchAgeMs=${watchAgeMs} restRemainingMs=0 state=${state.lastState || '-'} pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr} reason=REST_WINDOW_COMPLETED`
      );

      if (REST_EXIT_CHECK) {
        const cacheKey = AvailabilityCache.buildKey(date, route);
        const cached = this.cache.get(cacheKey, 15000);
        if (cached && cached.state === 'AVAILABLE') {
          SanitizedLogger.info(
            `[WORKER] key=${key} step=BOOKING watchAgeMs=${watchAgeMs} restRemainingMs=0 state=AVAILABLE pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr} transition=RESTING->BOOKING reason=REST_EXIT_CHECK_AVAILABLE`
          );
          state.phase = 'BOOKING';
          state.inFlight = true;
          try {
            await this.executeBookingFlow(key, state, date, route);
          } finally {
            state.inFlight = false;
          }
          return;
        }
      }

      // Resume WATCHING with reset watchStartedAt
      state.phase = 'WATCHING';
      state.watchStartedAt = now;
      state.restUntil = undefined;
      state.firstRestTick = false;
      SanitizedLogger.info(
        `[WORKER] key=${key} step=WATCHING watchAgeMs=0 restRemainingMs=- state=${state.lastState || '-'} pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr} transition=RESTING->WATCHING reason=REST_CYCLE_FINISHED_RESUME_WATCH`
      );
      return;
    }

    // ==========================================
    // PHASE 3: BOOKING
    // ==========================================
    if (state.phase === 'BOOKING') {
      // If phase is BOOKING and not inFlight, trigger execution flow
      state.inFlight = true;
      try {
        await this.executeBookingFlow(key, state, date, route);
      } finally {
        state.inFlight = false;
      }
      return;
    }

    // ==========================================
    // PHASE 4: COMPLETING
    // ==========================================
    if (state.phase === 'COMPLETING') {
      // Managed directly by completeExecution()
      return;
    }
  }

  /**
   * Performs pre-login public calendar check for date & route using persistent discovery adapter
   */
  private async pollAvailabilityForDate(keyOrDate: string, dateOrRoute?: string, routeOpt?: string): Promise<{ state: string; available: boolean }> {
    let key: string;
    let date: string;
    let route: string;

    if (routeOpt !== undefined) {
      key = keyOrDate;
      date = dateOrRoute || '';
      route = routeOpt;
    } else {
      date = keyOrDate;
      route = dateOrRoute || 'PAMBA';
      key = `${date}:${route}`;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const rawDate = (key.includes(':') ? key.split(':')[0] : key.split('|')[0]) || key;
      SanitizedLogger.error(`[DISCOVERY] invalid date input raw=${rawDate} parsed=${date} key=${key}`);
      return { state: 'ERROR', available: false };
    }

    const canonicalDate = date;
    const targetRoute = route || 'PAMBA';
    const cacheKey = AvailabilityCache.buildKey(canonicalDate, targetRoute);

    try {
      // Reuse persistent discovery adapter across polls (recycled every DISCOVERY_CONTEXT_RECYCLE_POLLS passes)
      const adapter = await this.ensureDiscoveryAdapter();
      if (!adapter) {
        return { state: 'UNREACHABLE', available: false };
      }

      // Ensure persistent discovery page is on https://sabarimalaonline.org/#/darshanAvailability
      const page = adapter.getPage();
      if (page && typeof page.url === 'function' && !page.url().includes('darshanAvailability')) {
        await adapter.openDarshanAvailability().catch(() => {});
      }

      const checkRes = await adapter.checkRequestedDateAvailability(canonicalDate);
      this.cache.set(cacheKey, checkRes.state);

      if (checkRes.state === 'AVAILABLE') {
        if (this.discoveryWorker) {
          this.discoveryWorker.emit('slot:opened', { date: canonicalDate, route: targetRoute });
        }
      }

      return { state: checkRes.state, available: checkRes.state === 'AVAILABLE' };
    } catch (err: any) {
      SanitizedLogger.warn(`[DISCOVERY] Availability check error for ${canonicalDate}:`, err.message || err);
      return { state: 'ERROR', available: false };
    }
  }

  /**
   * Phase 3 BOOKING: Atomic claim -> 10-step Playwright flow -> terminal outcome
   */
  private async executeBookingFlow(key: string, state: DemandKeyState, date: string, route: string): Promise<void> {
    const bookingIdsStr = state.bookingIds.join(',') || key;
    SanitizedLogger.info(`[WORKER] key=${key} AVAILABLE -> BOOKING`);
    SanitizedLogger.info(
      `[WORKER] key=${key} step=BOOKING watchAgeMs=${Date.now() - state.watchStartedAt} restRemainingMs=- state=AVAILABLE pollSeq=${state.pollSeq} bookingIds=${bookingIdsStr} action=CLAIM_AND_EXECUTE`
    );

    if (this.maxActiveBookings <= 0 || !this.heartbeat.isExecutionPermitted()) {
      SanitizedLogger.warn(`[WORKER] key=${key} step=BOOKING execution prohibited (capacity: ${this.maxActiveBookings}, permitted: ${this.heartbeat.isExecutionPermitted()}). Returning to WATCHING.`);
      state.phase = 'WATCHING';
      return;
    }

    // 1. Claim job from central API with triggerSource = 'SLOT_OPENED'
    let claimResult: any = null;
    try {
      claimResult = await this.apiClient.claimJob(Array.from(this.activeJobIds), {
        triggerSource: 'SLOT_OPENED',
        date,
        route,
      });
    } catch (err: any) {
      SanitizedLogger.error(`[WORKER] key=${key} claim error:`, err?.message || err);
      SanitizedLogger.info(`[WORKER] key=${key} AVAILABLE but claim lost -> back to WATCHING`);
      state.phase = 'WATCHING';
      return;
    }

    if (!claimResult || !claimResult.hasJob || !claimResult.job) {
      const reason = claimResult?.reason || claimResult?.message || 'NO_JOB';
      if (reason.startsWith('CLAIMED_BY_OTHER')) {
        const ownerId = claimResult?.ownerWorkerId || reason.replace(/^CLAIMED_BY_OTHER\((.*)\)$/, '$1');
        SanitizedLogger.warn(
          `[ORCHESTRATOR] Another worker is booking for ${date} (reason=${reason}, owner=${ownerId}). Standing down.`,
        );
      } else if (reason.startsWith('ALREADY_COMPLETED')) {
        SanitizedLogger.info(`[ORCHESTRATOR] ${reason} for ${date}. Refusing re-booking.`);
        await this.retryCompletionIfNeeded(claimResult);
      } else if (reason.startsWith('MAX_CAPACITY')) {
        SanitizedLogger.warn(`[ORCHESTRATOR] Claim refused for ${date}: ${reason}.`);
      } else if (reason.startsWith('ACCOUNT_BUSY')) {
        SanitizedLogger.warn(`[ORCHESTRATOR] Account busy for ${date}: ${reason}.`);
      } else {
        SanitizedLogger.warn(`[ORCHESTRATOR] Claim returned no job for ${date}: reason=${reason}.`);
      }
      SanitizedLogger.info(`[WORKER] key=${key} AVAILABLE but claim lost -> back to WATCHING`);
      SanitizedLogger.info(`[WORKER] key=${key} step=BOOKING claim refused (${reason}). Slot lost. Preserving existing watch window.`);
      // Failed claim (slot gone): Counter reset only on completed booking! Existing watch window preserved.
      state.phase = 'WATCHING';
      return;
    }

    const job = claimResult.job;
    const bookingKey = job.bookingRequestId || job.bookingCode || job.id;

    // 2. Acquire execution guard lock and log
    const lockRes = BookingExecutionGuard.acquire({
      bookingId: job.bookingRequestId || bookingKey,
      bookingCode: job.bookingCode || 'UNKNOWN',
      jobId: job.id,
      dispatchSource: 'SLOT_OPENED',
    });
    const lockAcquired = lockRes.acquired;
    SanitizedLogger.info(
      `[WORKER] key=${key} AVAILABLE -> BOOKING claim=SUCCESS(job=${job.id}) lock=${lockAcquired ? 'ACQUIRED' : 'ALREADY_LOCKED'}`
    );

    // Check duplicate protection
    if (await this.guardAlreadyCompletedJob(job)) {
      if (lockAcquired) {
        BookingExecutionGuard.release(bookingKey, job.id);
      }
      this.completeExecution(key, state, 'SUCCESS', 'ALREADY_COMPLETED');
      return;
    }

    // 3. Dispatch job through full Playwright flow
    this.activeExecutions++;
    this.activeJobIds.add(job.id);
    this.heartbeat.addActiveJob(job.id);

    let terminalStatus = 'FAILED';

    try {
      await this.processJobAsync(claimResult.jobType || 'BOOKING_EXECUTION', {
        ...job,
        verifiedAvailable: true,
        skipPreflight: true,
        dispatchSource: 'SLOT_OPENED',
      });
      terminalStatus = 'SUCCESS';
    } catch (flowErr: any) {
      SanitizedLogger.error(`[WORKER] key=${key} execution error:`, flowErr);
      terminalStatus = 'RETRYABLE_FAILURE';
    } finally {
      if (lockAcquired) {
        BookingExecutionGuard.release(bookingKey, job.id);
      }
      // 4. Phase 4: COMPLETING
      this.completeExecution(key, state, terminalStatus, `job_${job.id}`);
    }
  }

  /**
   * Phase 4 COMPLETING: Handles terminal outcomes, releases locks, and manages watch set
   */
  private completeExecution(key: string, state: DemandKeyState, status: string, reason?: string): void {
    state.phase = 'COMPLETING';
    const now = Date.now();
    SanitizedLogger.info(
      `[WORKER] key=${key} step=COMPLETING watchAgeMs=${now - state.watchStartedAt} restRemainingMs=- state=- pollSeq=${state.pollSeq} bookingIds=${state.bookingIds.join(',')} terminalStatus=${status} reason=${reason || '-'}`
    );

    if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'BOOKING_CONFIRMED') {
      // Terminal SUCCESS: remove key from watch set (booking done)
      state.phase = 'COMPLETING';
      this.keyStates.delete(key);
      SanitizedLogger.info(`[WORKER] key=${key} booking SUCCESS -> loop removed.`);
      SanitizedLogger.info(`[WORKER] key=${key} booking terminal (${status}) -> removed`);
    } else {
      // Terminal retryable/failed: keep key in watch set, set phase = WATCHING, reset watchStartedAt = now (fresh 10m window)
      state.phase = 'WATCHING';
      state.watchStartedAt = now;
      state.restUntil = undefined;
      state.firstRestTick = false;
      SanitizedLogger.info(`[WORKER] key=${key} booking FAILED (retryable) -> back to WATCHING; reset watchStartedAt = now`);
      SanitizedLogger.info(`[WORKER] key=${key} booking terminal (${status}) -> back to WATCHING`);
    }
  }

  /**
   * Queue poll fallback when watch set is empty or idle: polls general execution jobs
   */
  private async pollUnscheduledJobQueue(): Promise<void> {
    try {
      const claimResult = await this.apiClient.claimJob(Array.from(this.activeJobIds), {
        triggerSource: 'QUEUE_POLL',
        maxActiveBookings: this.maxActiveBookings,
      });

      if (claimResult && claimResult.hasJob && claimResult.job) {
        // Booking jobs must NEVER be claimed speculatively while date availability is not confirmed
        if (claimResult.jobType !== 'ACCOUNT_VERIFICATION') {
          return;
        }

        const job = claimResult.job;
        const bookingKey = job.bookingRequestId || job.bookingCode || job.id;

        if (await this.guardAlreadyCompletedJob(job)) {
          return;
        }

        if (BookingExecutionGuard.isBookingActive(bookingKey) || this.activeJobIds.has(job.id)) {
          return;
        }

        this.activeExecutions++;
        this.activeJobIds.add(job.id);
        this.processJobAsync(claimResult.jobType, job).catch((err) => {
          SanitizedLogger.error('[WORKER] Error in background execution:', err);
        });
      }
    } catch (_) {}
  }

  /**
   * Deliverable 4: Account Verification as an independent background task
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  private startBackgroundVerificationTask(): void {
    const verifyIntervalMs = 15000;
    this.verificationLoopTimer = setInterval(async () => {
      if (!this.isRunning || !this.heartbeat.isExecutionPermitted()) {
        return;
      }
      try {
        const claimResult = await this.apiClient.claimJob(Array.from(this.activeJobIds), {
          triggerSource: 'QUEUE_POLL',
          jobType: 'ACCOUNT_VERIFICATION',
          maxActiveBookings: this.maxActiveBookings,
        });
        if (claimResult?.hasJob && claimResult.job && claimResult.jobType === 'ACCOUNT_VERIFICATION') {
          SanitizedLogger.info(`[BACKGROUND-VERIFICATION] Executing official account verification: ${claimResult.job.username}`);
          this.activeJobIds.add(claimResult.job.id);
          try {
            await this.verificationWorker.execute(claimResult.job);
          } finally {
            this.activeJobIds.delete(claimResult.job.id);
          }
        }
      } catch (err: any) {
        // Verification background error does not impact main engine
      }
    }, verifyIntervalMs);
    if (this.verificationLoopTimer && typeof this.verificationLoopTimer.unref === 'function') {
      this.verificationLoopTimer.unref();
    }
  }

  /**
   * PR #4 Patch: Handles slot:opened event trigger
   */
  public async handleSlotOpened(date: string, route?: string): Promise<boolean> {
    if (!date) return false;

    const debounceKey = `${date}|${route || ''}`;
    const now = Date.now();
    const lastOpenedAt = this.lastSlotOpenedMap.get(debounceKey);

    if (lastOpenedAt !== undefined && (now - lastOpenedAt) < this.slotOpenDebounceMs) {
      const diff = now - lastOpenedAt;
      SanitizedLogger.info(`[ORCHESTRATOR] Debounced duplicate slot:opened for ${date} (last was ${diff}ms ago).`);
      return false;
    }
    this.lastSlotOpenedMap.set(debounceKey, now);

    if (!this.heartbeat.isExecutionPermitted() || this.maxActiveBookings <= 0) {
      return false;
    }

    if (this.activeExecutions >= this.maxActiveBookings) {
      SanitizedLogger.warn(`[ORCHESTRATOR] slot:opened received for ${date}, but worker is at max concurrency (${this.activeExecutions}/${this.maxActiveBookings}).`);
      return false;
    }

    const hasJob = await this.hasMatchingPendingJob(date, route);
    if (!hasJob) {
      SanitizedLogger.info(`[ORCHESTRATOR] Slot opened for ${date} but no matching pending job. Skipping claim.`);
      return false;
    }

    const canonicalDate = normalizeDate(date);
    const targetRoute = route || 'Pamba (Regular Footpath Route)';
    const targetKey = normalizeDemandKey(canonicalDate, targetRoute);
    let state = this.keyStates.get(targetKey);
    if (!state) {
      // Check if there is a matching state by date
      for (const [k, s] of this.keyStates.entries()) {
        const parsed = this.parseDemandKey(k);
        if (parsed.date === canonicalDate) {
          state = s;
          break;
        }
      }
    }

    if (state) {
      if (state.phase === 'BOOKING' || state.inFlight) {
        // Already handling booking for this key, prevent duplicate invocation
        return true;
      }
      state.phase = 'BOOKING';
      state.inFlight = true;
      try {
        await this.executeBookingFlow(state.demandKey, state, canonicalDate, targetRoute);
        return true;
      } finally {
        state.inFlight = false;
      }
    } else {
      // Direct execution without pre-existing state
      const newState: DemandKeyState = {
        demandKey: targetKey,
        phase: 'BOOKING',
        watchStartedAt: now,
        bookingIds: [targetKey],
        pollSeq: 0,
        inFlight: true,
      };
      this.keyStates.set(targetKey, newState);
      try {
        await this.executeBookingFlow(targetKey, newState, canonicalDate, targetRoute);
        return true;
      } finally {
        newState.inFlight = false;
      }
    }
  }

  public async triggerImmediateClaim(date?: string, route?: string): Promise<boolean> {
    if (!date) return false;
    return this.handleSlotOpened(date, route);
  }

  public async hasMatchingPendingJob(date: string, route?: string): Promise<boolean> {
    const canonicalDate = normalizeDate(date);
    const targetKey = AvailabilityCache.buildKey(date, route);

    if (this.localPendingJobs && this.localPendingJobs.length > 0) {
      const match = this.localPendingJobs.some((job) => {
        if (normalizeDate(job.date) !== canonicalDate) return false;
        if (route && job.route) {
          return AvailabilityCache.buildKey(job.date, job.route) === targetKey;
        }
        return true;
      });
      if (match) return true;
    }

    if (this.discoveryWorker?.retryableDemands && this.discoveryWorker.retryableDemands.size > 0) {
      for (const [key, dem] of this.discoveryWorker.retryableDemands.entries()) {
        if (key === targetKey || normalizeDate(dem.date) === canonicalDate) {
          return true;
        }
      }
    }

    if (this.apiClient && typeof this.apiClient.getDemandDates === 'function') {
      try {
        const demands = await this.apiClient.getDemandDates();
        if (Array.isArray(demands) && demands.length > 0) {
          const match = demands.some((d: any) => {
            if (normalizeDate(d.date) !== canonicalDate) return false;
            if (route && d.route) {
              return AvailabilityCache.buildKey(d.date, d.route) === targetKey;
            }
            return true;
          });
          if (match) return true;
        }
      } catch (err: any) {
        SanitizedLogger.warn(`[ORCHESTRATOR] Error checking demand dates: ${err?.message || err}`);
      }
    }

    if (this.apiClient && typeof (this.apiClient as any).getPendingDates === 'function') {
      try {
        const pending = await (this.apiClient as any).getPendingDates();
        if (pending?.dates && Array.isArray(pending.dates)) {
          if (pending.dates.some((d: string) => normalizeDate(d) === canonicalDate)) {
            return true;
          }
        }
      } catch (_) {}
    }

    return false;
  }

  public setLocalPendingJobs(jobs: Array<{ date: string; route?: string }>): void {
    this.localPendingJobs = jobs;
  }

  private async guardAlreadyCompletedJob(job: any): Promise<boolean> {
    if (!job) return false;
    const bookingKey = job.bookingRequestId || job.bookingCode || job.id;
    const pending =
      PendingCompletionsManager.getPending(job.id) ||
      PendingCompletionsManager.getPending(bookingKey);
    const storedRef =
      pending?.officialBookingReference ||
      pending?.officialReference ||
      job.officialBookingReference ||
      job.officialReference;

    const isAuthoritativeRef = Boolean(
      storedRef &&
        typeof storedRef === 'string' &&
        storedRef.trim().length >= 5 &&
        !storedRef.trim().startsWith('SAB-2026-'),
    );

    if (!isAuthoritativeRef) {
      return false;
    }

    const cleanRef = storedRef.trim();
    SanitizedLogger.warn(
      `[DUPLICATE-GUARD] ALREADY_COMPLETED(${cleanRef}) for Booking #${job.bookingCode || bookingKey} (Job #${job.id}). Refusing re-booking; retrying completeJob.`,
    );

    if (typeof this.apiClient.completeJob === 'function') {
      try {
        await this.apiClient.completeJob(job.id, {
          officialReference: cleanRef,
          officialBookingReference: cleanRef,
          cartId: pending?.cartId || job.cartId,
          leaseGeneration: job.leaseGeneration ?? pending?.leaseGeneration ?? 1,
          fencingToken: job.fencingToken ?? pending?.fencingToken ?? 'duplicate-guard-retry',
          protocolVersion: 'v2.0-fenced',
        });
        PendingCompletionsManager.removePending(job.id);
      } catch (err: any) {
        SanitizedLogger.warn(`[DUPLICATE-GUARD] completeJob retry notice for Job #${job.id}: ${err?.message || err}`);
      }
    }
    return true;
  }

  private async retryCompletionIfNeeded(res: any): Promise<void> {
    if (
      res?.needsCompletionRetry &&
      res?.jobId &&
      res?.officialReference &&
      typeof this.apiClient.completeJob === 'function'
    ) {
      SanitizedLogger.info(
        `[DUPLICATE-GUARD] Retrying completeJob for Job #${res.jobId} with stored reference ${res.officialReference}.`,
      );
      await this.apiClient
        .completeJob(res.jobId, {
          officialReference: res.officialReference,
          officialBookingReference: res.officialReference,
        })
        .catch((err: any) =>
          SanitizedLogger.warn(`[DUPLICATE-GUARD] completeJob retry notice: ${err?.message || err}`),
        );
    }
  }

  public dispatchSnipedJob(jobType: string, job: any) {
    if (this.activeExecutions >= this.maxActiveBookings) {
      SanitizedLogger.warn(
        `[Worker] Sniped job #${job.id} for booking #${job.bookingCode || job.id} received, but worker is at max concurrency (${this.activeExecutions}/${this.maxActiveBookings}).`
      );
      return;
    }

    const bookingKey = job.bookingRequestId || job.bookingCode || job.id;

    const pending =
      PendingCompletionsManager.getPending(job.id) ||
      PendingCompletionsManager.getPending(bookingKey);
    const existingRef =
      pending?.officialBookingReference ||
      pending?.officialReference ||
      job.officialBookingReference ||
      job.officialReference;
    if (existingRef && typeof existingRef === 'string' && existingRef.trim().length >= 5 && !existingRef.trim().startsWith('SAB-2026-')) {
      this.guardAlreadyCompletedJob(job).catch(() => {});
      return;
    }

    if (BookingExecutionGuard.isBookingActive(bookingKey) || this.activeJobIds.has(job.id)) {
      SanitizedLogger.warn(
        `[Worker] Deduplication: Sniped job #${job.id} for booking #${job.bookingCode || bookingKey} is already active. Skipping duplicate dispatch.`
      );
      return;
    }

    this.activeExecutions++;
    this.activeJobIds.add(job.id);

    if (job.bookingCode?.startsWith('TA-GRAB-')) {
      SanitizedLogger.warn(`[SNIPER] Sniped booking #${job.bookingCode} received without pre-reserved wallet funds. If confirmed, completeJob will attempt to capture fee directly from available balance.`);
    }

    SanitizedLogger.info(`[Worker] ⚡ Fast-dispatching sniped booking #${job.bookingCode || job.id} directly to execution engine!`);
    this.processJobAsync(jobType, {
      ...job,
      dispatchSource: 'SNIPER',
      verifiedAvailable: true,
      skipPreflight: true,
    });
  }

  private async processJobAsync(jobType: string, job: any) {
    this.heartbeat.addActiveJob(job.id);
    this.activeJobIds.add(job.id);

    const isBooking = jobType !== 'ACCOUNT_VERIFICATION';
    let lockAcquired = false;

    if (isBooking) {
      const bId = job.bookingRequestId || job.id;
      const isAlreadyActiveForSameJob = BookingExecutionGuard.isBookingActive(bId);

      if (!isAlreadyActiveForSameJob) {
        const lockRes = BookingExecutionGuard.acquire({
          bookingId: bId,
          bookingCode: job.bookingCode || job.id,
          jobId: job.id,
          dispatchSource: job.dispatchSource || 'QUEUE_POLL',
          owner: 'WORKER_ORCHESTRATOR',
        });

        if (!lockRes.acquired) {
          SanitizedLogger.warn(
            `[Worker] Deduplication guard: Aborting duplicate dispatch for Booking #${job.bookingCode || job.id}. Lock owned by Job #${lockRes.existingLock?.jobId}.`
          );
          this.activeExecutions = Math.max(0, this.activeExecutions - 1);
          this.activeJobIds.delete(job.id);
          this.heartbeat.removeActiveJob(job.id);
          return;
        }
        lockAcquired = true;
        job.attemptId = lockRes.attemptId;
      }
    }

    // Active lease renewal heartbeat timer (every LEASE_RENEWAL_MS, default 10s)
    let leaseLost = false;
    const leaseTimer = setInterval(async () => {
      if (leaseLost) return;
      try {
        if (job.leaseGeneration === undefined || job.leaseGeneration === null || !job.fencingToken) {
          throw new Error(`LEASE_INCOMPLETE: Missing leaseGeneration or fencingToken on job #${job.id}`);
        }
        await this.apiClient.updateJobProgress(job.id, {
          status: 'EXECUTING',
          note: 'Worker active lease heartbeat',
          leaseGeneration: job.leaseGeneration,
          fencingToken: job.fencingToken,
        });
      } catch (err: any) {
        if (err?.response?.status === 409 || err?.response?.status === 403 || err?.message?.includes('LEASE_INCOMPLETE')) {
          leaseLost = true;
          clearInterval(leaseTimer);
          SanitizedLogger.warn(`[ARBITER] Lease heartbeat rejected: job=${job.id} (lease expired or reassigned) — stopping heartbeat, continuing in-flight execution to completion.`);
        } else {
          SanitizedLogger.warn(`[Lease] Heartbeat notice for Job ID: ${job.id}`);
        }
      }
    }, LEASE_RENEWAL_MS);

    try {
      if (jobType === 'ACCOUNT_VERIFICATION') {
        SanitizedLogger.info(`[Worker] Executing Official Account Verification: ${job.username}`);
        await this.verificationWorker.execute(job);
      } else {
        SanitizedLogger.info(`[Worker] Executing Booking Workflow: #${job.bookingCode || job.id}`);
        await this.bookingWorker.execute(job);
      }
    } catch (err: any) {
      SanitizedLogger.error(`[Worker] Job execution unhandled exception:`, err);
      throw err;
    } finally {
      clearInterval(leaseTimer);
      if (isBooking && lockAcquired) {
        BookingExecutionGuard.release(job.bookingRequestId || job.bookingCode || job.id, job.id);
      }
      this.activeJobIds.delete(job.id);
      this.activeExecutions = Math.max(0, this.activeExecutions - 1);
      this.heartbeat.removeActiveJob(job.id);
    }
  }
}
