import { EventEmitter } from 'events';
import { ApiClient } from '../api/client';
import { PlaywrightSabarimalaAdapter } from '../sabarimala/sabarimala-adapter';
import { SanitizedLogger } from '../monitoring/logger';
import { normalizeDate } from '../sabarimala/virtual-q';
import { normalizeDemandKey } from './demand-key';
import { AvailabilityState, CheckResult } from '../sabarimala/darshan-availability';
import { AvailabilityCache } from './availability-cache';

// GAP-13 / PR-5: read interval, backoff, and recycle configuration from env with consistent fallback
export const AVAILABILITY_POLL_INTERVAL_MS = Number(
  process.env.AVAILABILITY_POLL_INTERVAL_MS
    ?? process.env.DISCOVERY_INTERVAL_MS
    ?? 8000
);
export const AVAILABILITY_POLL_JITTER_MS = Number(process.env.AVAILABILITY_POLL_JITTER_MS ?? 4000);
const BACKOFF_ON_RATE_LIMIT_MS = Number(process.env.BACKOFF_ON_RATE_LIMIT_MS ?? 60000);
const BACKOFF_ON_BLOCKED_MS = Number(process.env.BACKOFF_ON_BLOCKED_MS ?? 300_000);
const BACKOFF_ON_UNREACHABLE_MS = Number(process.env.BACKOFF_ON_UNREACHABLE_MS ?? 30_000);

export class AvailabilityDiscoveryWorker extends EventEmitter {
  private isChecking = false;

  // PR-5: nextDueAt must be driven by AVAILABILITY_POLL_INTERVAL_MS, not hardcoded 30s
  public nextDueAt: number = 0;

  // Task 1: In-memory cache for confirmed available dates
  public availableDatesSet: Set<string> = new Set<string>();

  // Task 4: In-memory cache for backoff on faulted dates (Map<date, nextCheckTime>)
  public failedDateBackoffMap: Map<string, number> = new Map<string, number>();

  // GAP-04 / PR #4: Retryable demand tracking so worker never goes idle on RETRYABLE_FAILURE
  public retryableDemands: Map<string, { date: string; route: string }> = new Map();

  // GAP-02: Persistent discovery adapter/page with periodic recycle
  private persistentAdapter: PlaywrightSabarimalaAdapter | null = null;
  private passesSinceRecycle = 0;

  constructor(
    private apiClient: ApiClient,
    private onBookingSniped?: (jobType: string, job: any) => void,
    private cache: AvailabilityCache = AvailabilityCache.getInstance(),
    private getActiveJobIds?: () => string[],
  ) {
    super();
  }

  public registerRetryableDemand(date: string, route: string = 'Pamba (Regular Footpath Route)') {
    const canonicalDate = normalizeDate(date);
    const key = AvailabilityCache.buildKey(canonicalDate, route);
    this.retryableDemands.set(key, { date: canonicalDate, route });
    SanitizedLogger.info(`[DISCOVERY] Registered RETRYABLE_FAILURE demand for date ${canonicalDate} / ${route}`);
  }

  /**
   * GAP-02: Ensure persistent adapter/page and recycle every DISCOVERY_CONTEXT_RECYCLE_POLLS passes
   */
  async ensureAdapter(): Promise<PlaywrightSabarimalaAdapter> {
    const recycleLimit = Number(process.env.DISCOVERY_CONTEXT_RECYCLE_POLLS ?? 500);
    this.passesSinceRecycle++;

    if (!this.persistentAdapter || this.passesSinceRecycle >= recycleLimit) {
      if (this.persistentAdapter) {
        await this.persistentAdapter.close().catch(() => {});
        SanitizedLogger.info(`[DISCOVERY] Context recycled after ${this.passesSinceRecycle} passes`);
      }
      this.persistentAdapter = new PlaywrightSabarimalaAdapter();
      await this.persistentAdapter.init();
      if (this.passesSinceRecycle >= recycleLimit) {
        this.passesSinceRecycle = 0;
      }
    }
    return this.persistentAdapter;
  }

  /**
   * GAP-02: Close persistent context on worker shutdown
   */
  async shutdown(): Promise<void> {
    if (this.persistentAdapter) {
      await this.persistentAdapter.close().catch(() => {});
      this.persistentAdapter = null;
      this.passesSinceRecycle = 0;
      SanitizedLogger.info('[DISCOVERY] Persistent context closed on shutdown.');
    }
  }

  /**
   * Executes an intelligent, distributed-throttled discovery pass across active demand dates.
   * Entry Point: https://sabarimalaonline.org/#/darshanAvailability (Public pre-login page)
   * 
   * Features:
   * - Demand-based: only inspects dates with active pending customer demand.
   * - Distributed deduplication: acquires an atomic lock per demand key.
   * - Interval throttling: skips browser launches when demands are within fault backoff windows.
   * - Browser lifecycle optimization: zero browser launches when no demands are due.
   * - Structured logging: [DISCOVERY] tags with demandKey, lastCheckedAt, nextCheckAt.
   */
  async runDiscoveryPass(workerId: string = 'worker-node'): Promise<void> {
    if (this.isChecking) {
      return;
    }

    this.isChecking = true;

    // PR-5: nextDueAt must be driven by AVAILABILITY_POLL_INTERVAL_MS, not hardcoded 30s
    const baseInterval = Number(
      process.env.AVAILABILITY_POLL_INTERVAL_MS
        ?? process.env.DISCOVERY_INTERVAL_MS
        ?? 8000
    );
    const jitterMs = Number(process.env.AVAILABILITY_POLL_JITTER_MS ?? 4000);
    this.nextDueAt = Date.now() + baseInterval + Math.floor(Math.random() * jitterMs);

    try {
      // 1. Fetch active demand dates with schedule state from API
      let demandGroups: any[] = [];
      try {
        demandGroups = await this.apiClient.getDemandDates();
      } catch (err: any) {
        SanitizedLogger.warn(`[DISCOVERY] Failed to fetch demand dates: ${err.message}`);
      }

      // Supplementary fallback: check getPendingDates if demandGroups is empty
      if (!demandGroups || demandGroups.length === 0) {
        try {
          if (typeof this.apiClient.getPendingDates === 'function') {
            const pending = await this.apiClient.getPendingDates();
            if (pending?.dates && pending.dates.length > 0) {
              demandGroups = pending.dates.map((d: string) => ({
                date: d,
                route: 'Pamba (Regular Footpath Route)',
                pendingCount: 1,
              }));
            }
          }
        } catch (_) {}
      }

      // GAP-04 / PR #4: Include RETRYABLE_FAILURE demands so engine never goes idle
      for (const [key, retryable] of this.retryableDemands.entries()) {
        const canonical = normalizeDate(retryable.date);
        const exists = demandGroups.some((d) => normalizeDate(d.date) === canonical);
        if (!exists) {
          demandGroups.push({
            demandKey: key,
            date: canonical,
            route: retryable.route,
            pendingCount: 1,
            isDue: true,
          });
        }
      }

      if (!demandGroups || demandGroups.length === 0) {
        return;
      }

      SanitizedLogger.info(`[DISCOVERY] Demand list: ${demandGroups.map((d: any) => `${d.date}|${d.route}`).join(', ')}`);

      // 2. Identify due demands (GAP-01: Backoff only on real faults, not on FULL/DISABLED)
      const now = Date.now();
      const dueDemands = demandGroups.filter((g: any) => {
        const canonical = normalizeDate(g.date);
        const nextCheckTime = this.failedDateBackoffMap.get(canonical);
        if (nextCheckTime && now < nextCheckTime) {
          const remainingSec = Math.round((nextCheckTime - now) / 1000);
          SanitizedLogger.info(
            `[DISCOVERY] Date ${canonical} in fault backoff (${remainingSec}s remaining). Skipping.`
          );
          return false;
        }
        return g.isDue !== false;
      });

      if (dueDemands.length === 0) {
        // All active demands are within fault backoff or scheduled intervals. Skip browser launch completely.
        const nextUpcoming = demandGroups
          .filter((g: any) => g.nextCheckAt)
          .sort((a: any, b: any) => (a.nextCheckAt > b.nextCheckAt ? 1 : -1))[0];

        SanitizedLogger.info(
          `[DISCOVERY] No demand dates due for inspection (all in backoff or within scheduled intervals). Browser launch skipped. Next due: ${nextUpcoming?.demandKey || 'none'} at ${nextUpcoming?.nextCheckAt || 'N/A'}`
        );
        return;
      }

      // 3. Atomically claim due demands to prevent concurrent multi-worker scanning
      const claimedDemands: any[] = [];
      for (const demand of dueDemands) {
        const demandKey = demand.demandKey || normalizeDemandKey(demand.date, demand.route);
        let claimed = true;

        if (typeof this.apiClient.claimDemand === 'function') {
          try {
            const claimRes = await this.apiClient.claimDemand(demandKey, workerId);
            claimed = claimRes?.claimed ?? true;
          } catch (claimErr: any) {
            SanitizedLogger.warn(`[DISCOVERY] demandKey=${demandKey} claim error: ${claimErr.message}. Proceeding locally.`);
            claimed = true;
          }
        }

        if (claimed) {
          claimedDemands.push({ ...demand, demandKey });
        } else {
          SanitizedLogger.info(
            `[DISCOVERY] demandKey=${demandKey} lastCheckedAt=${demand.lastCheckedAt || 'NEVER'} nextCheckAt=${demand.nextCheckAt || 'N/A'} deduplication=SKIPPED`
          );
        }
      }

      if (claimedDemands.length === 0) {
        SanitizedLogger.info('[DISCOVERY] All due demands claimed or in-flight by another worker. Browser launch skipped.');
        return;
      }

      // 4. Open official Darshan Availability page only now that at least one demand is claimed
      // GAP-02: reuse persistent adapter across passes
      const adapter = await this.ensureAdapter();
      const passStartTime = Date.now();

      try {
        const openResult = await adapter.openDarshanAvailability();
        if (!openResult.success) {
          SanitizedLogger.warn('[DISCOVERY] Official portal darshanAvailability unreachable during discovery pass');
          // GAP-02: recycle adapter if page navigation failed
          if (this.persistentAdapter) {
            await this.persistentAdapter.close().catch(() => {});
            this.persistentAdapter = null;
            this.passesSinceRecycle = 0;
          }
          for (const d of claimedDemands) {
            if (typeof this.apiClient.releaseDemand === 'function') {
              await this.apiClient.releaseDemand(d.demandKey, workerId, 'ERROR', Date.now() - passStartTime, 'Page unreachable');
            }
          }
          return;
        }

        const discoveredOpportunities: Array<{ date: string; route: string; timeSlot?: string; source: string }> = [];

        // 5. Inspect each claimed target demand date on official calendar
        for (const demand of claimedDemands) {
          const canonicalDate = normalizeDate(demand.date);
          const targetRoute = demand.route || 'Pamba (Regular Footpath Route)';
          const demandKey = demand.demandKey;
          const scanStartTime = Date.now();

          const checkResult = await adapter.checkRequestedDateAvailability(canonicalDate);

          // GAP-04: Update shared AvailabilityCache
          const cacheKey = AvailabilityCache.buildKey(canonicalDate, targetRoute);
          const previous = this.cache.get(cacheKey, Number.MAX_SAFE_INTEGER);
          const previousState = previous?.state;
          this.cache.set(cacheKey, checkResult.state);

          // GAP-16 / PR #4: If previous state was FULL or DISABLED and new is AVAILABLE, emit slot:opened
          if ((previousState === 'FULL' || previousState === 'DISABLED') && checkResult.state === 'AVAILABLE') {
            SanitizedLogger.info(`[DISCOVERY] ⚡ Slot opened for ${canonicalDate} / ${targetRoute}! Emitting slot:opened event.`);
            this.emit('slot:opened', { date: canonicalDate, route: targetRoute });
          }

          // GAP-01: FULL is a valid answer, not an error. Re-check on next tick.
          // Backoff ONLY on real faults (429/403/5xx/network).
          switch (checkResult.state) {
            case 'AVAILABLE':
              this.failedDateBackoffMap.delete(canonicalDate);
              this.availableDatesSet.add(canonicalDate);
              SanitizedLogger.info(`[DISCOVERY] Date ${canonicalDate} AVAILABLE`);
              break;

            case 'FULL':
            case 'DISABLED':
              // No backoff. FULL is a valid answer. Watching continues.
              this.failedDateBackoffMap.delete(canonicalDate);
              this.availableDatesSet.delete(canonicalDate);
              SanitizedLogger.info(`[DISCOVERY] Date ${canonicalDate} ${checkResult.state} — watching (no backoff)`);
              break;

            case 'RATE_LIMITED':
              this.failedDateBackoffMap.set(canonicalDate, Date.now() + BACKOFF_ON_RATE_LIMIT_MS);
              SanitizedLogger.warn(`[DISCOVERY] Date ${canonicalDate} RATE_LIMITED (429) — ${BACKOFF_ON_RATE_LIMIT_MS}ms backoff`);
              break;

            case 'BLOCKED':
              this.failedDateBackoffMap.set(canonicalDate, Date.now() + BACKOFF_ON_BLOCKED_MS);
              SanitizedLogger.warn(`[DISCOVERY] Date ${canonicalDate} BLOCKED (403) — ${BACKOFF_ON_BLOCKED_MS}ms backoff`);
              break;

            case 'TRANSIENT':
              this.failedDateBackoffMap.set(canonicalDate, Date.now() + BACKOFF_ON_UNREACHABLE_MS);
              SanitizedLogger.warn(`[DISCOVERY] Date ${canonicalDate} TRANSIENT (${checkResult.httpStatus}) — ${BACKOFF_ON_UNREACHABLE_MS}ms backoff`);
              break;

            case 'UNREACHABLE':
              this.failedDateBackoffMap.set(canonicalDate, Date.now() + BACKOFF_ON_UNREACHABLE_MS);
              SanitizedLogger.warn(`[DISCOVERY] Date ${canonicalDate} UNREACHABLE — ${BACKOFF_ON_UNREACHABLE_MS}ms backoff`);
              break;

            case 'UNKNOWN':
              // Treat as transient — short backoff, but do not stop watching
              this.failedDateBackoffMap.set(canonicalDate, Date.now() + BACKOFF_ON_UNREACHABLE_MS);
              SanitizedLogger.warn(`[DISCOVERY] Date ${canonicalDate} UNKNOWN state — ${BACKOFF_ON_UNREACHABLE_MS}ms backoff`);
              break;
          }

          if (checkResult.state === 'AVAILABLE') {
            try {
              // Select date
              await adapter.selectRequestedDate(canonicalDate);

              // Select route
              const routeResult = await adapter.selectRoute(targetRoute);
              const verifiedRoute = routeResult.selectedRoute || targetRoute;

              SanitizedLogger.info(`[DISCOVERY] 🟢 Date and route verified available: ${canonicalDate} / ${verifiedRoute}`);
              discoveredOpportunities.push({
                date: canonicalDate,
                route: verifiedRoute,
                source: 'SABARIMALA_DARSHAN_AVAILABILITY',
              });

              // Task 2: Cancellation Sniping - Instantly grab oldest pending booking for this date
              if (typeof this.apiClient.matchPending === 'function') {
                try {
                  SanitizedLogger.info(`[SNIPER] 🎯 Date ${canonicalDate} is AVAILABLE! Triggering cancellation sniping via match-pending...`);
                  const activeIds = this.getActiveJobIds ? this.getActiveJobIds() : undefined;
                  const matchRes = activeIds !== undefined
                    ? await this.apiClient.matchPending(canonicalDate, verifiedRoute, activeIds)
                    : await this.apiClient.matchPending(canonicalDate, verifiedRoute);
                  if (matchRes && matchRes.hasJob && matchRes.job) {
                    const takeoverTag = (matchRes as any).takeoverReason ? ` (${(matchRes as any).takeoverReason})` : '';
                    SanitizedLogger.info(`[SNIPER] 🚀 Successfully claimed sniped booking #${matchRes.job.bookingCode || matchRes.job.id} for ${canonicalDate}${takeoverTag}! Dispatching execution.`);
                    if (this.onBookingSniped) {
                      this.onBookingSniped(matchRes.jobType || 'BOOKING_EXECUTION', matchRes.job);
                    }
                  } else {
                    const reason = (matchRes as any)?.reason || (matchRes as any)?.message || 'NO_JOB';
                    if (reason.startsWith('ALREADY_COMPLETED')) {
                      SanitizedLogger.info(`[SNIPER] ${reason} for ${canonicalDate}. Skipping re-booking.`);
                      if ((matchRes as any)?.needsCompletionRetry && (matchRes as any)?.jobId && (matchRes as any)?.officialReference && typeof this.apiClient.completeJob === 'function') {
                        SanitizedLogger.info(`[SNIPER] Retrying completeJob for Job #${(matchRes as any).jobId} with stored reference ${(matchRes as any).officialReference}...`);
                        await this.apiClient.completeJob((matchRes as any).jobId, {
                          officialReference: (matchRes as any).officialReference,
                          officialBookingReference: (matchRes as any).officialReference,
                        }).catch((e: any) => SanitizedLogger.warn(`[SNIPER] completeJob retry notice: ${e?.message || e}`));
                      }
                    } else if (reason.startsWith('CLAIMED_BY_OTHER')) {
                      SanitizedLogger.warn(`[SNIPER] Another worker is booking ${canonicalDate}: ${reason}. Standing down.`);
                    } else {
                      SanitizedLogger.info(`[SNIPER] Sniper claim refused for ${canonicalDate} (${verifiedRoute || 'any route'}): reason=${reason}. Emitting slot:opened fallback...`);
                      this.emit('slot:opened', { date: canonicalDate, route: verifiedRoute });
                    }
                  }
                } catch (snipeErr: any) {
                  SanitizedLogger.warn(`[SNIPER] match-pending claim error for ${canonicalDate}: ${snipeErr.message}`);
                }
              }

              if (typeof this.apiClient.releaseDemand === 'function') {
                await this.apiClient.releaseDemand(demandKey, workerId, 'AVAILABLE', Date.now() - scanStartTime);
              }
            } catch (selErr: any) {
              SanitizedLogger.warn(`[DISCOVERY] Error selecting open date ${canonicalDate}:`, selErr.message);
              if (typeof this.apiClient.releaseDemand === 'function') {
                await this.apiClient.releaseDemand(demandKey, workerId, 'ERROR', Date.now() - scanStartTime, selErr.message);
              }
            }
          } else {
            // Non-AVAILABLE state (FULL, DISABLED, RATE_LIMITED, etc.)
            if (typeof this.apiClient.releaseDemand === 'function') {
              await this.apiClient.releaseDemand(demandKey, workerId, 'UNAVAILABLE', Date.now() - scanStartTime);
            }
          }
        }

        // 6. Publish bulk discovered availability events to API Smart Matcher
        if (discoveredOpportunities.length > 0) {
          SanitizedLogger.info(`[DISCOVERY] Discovered ${discoveredOpportunities.length} available date/route opportunity(ies)!`);
          for (const opp of discoveredOpportunities) {
            SanitizedLogger.info(`[DISCOVERY] Available: ${opp.date} / ${opp.route}`);
          }
          await this.apiClient.publishBulkAvailability(discoveredOpportunities);
        } else {
          SanitizedLogger.info('[DISCOVERY] No new availability events discovered for inspected demand dates.');
        }
      } catch (innerErr: any) {
        SanitizedLogger.error('[DISCOVERY] Error during portal discovery execution:', innerErr);
        // GAP-02: recycle adapter if pass threw an unexpected exception
        if (this.persistentAdapter) {
          await this.persistentAdapter.close().catch(() => {});
          this.persistentAdapter = null;
          this.passesSinceRecycle = 0;
        }
        for (const d of claimedDemands) {
          if (typeof this.apiClient.releaseDemand === 'function') {
            await this.apiClient.releaseDemand(d.demandKey, workerId, 'ERROR', Date.now() - passStartTime, innerErr.message);
          }
        }
      }
    } catch (err: any) {
      SanitizedLogger.error('[DISCOVERY] Error in discovery pass:', err);
    } finally {
      this.isChecking = false;
    }
  }
}
