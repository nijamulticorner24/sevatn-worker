import { AvailabilityState } from '../sabarimala/darshan-availability';
import { normalizeDate } from '../sabarimala/virtual-q';
import { normalizeRouteCanonical } from '../sabarimala/constants/sabarimala-routes';

export interface CachedAvailability {
  state: AvailabilityState;
  observedAt: number;
}

/**
 * GAP-04: Shared in-memory availability cache
 * Stores date_route -> { state: AvailabilityState, observedAt: number }
 */
export class AvailabilityCache {
  private static instance: AvailabilityCache;
  private cache: Map<string, CachedAvailability> = new Map();

  static getInstance(): AvailabilityCache {
    if (!AvailabilityCache.instance) {
      AvailabilityCache.instance = new AvailabilityCache();
    }
    return AvailabilityCache.instance;
  }

  /**
   * Helper to normalize date and route into standard date_route key
   */
  static buildKey(date: string | Date, route?: string): string {
    const canonicalDate = normalizeDate(date);
    const routeCanonical = normalizeRouteCanonical(route);
    return `${canonicalDate}_${routeCanonical}`;
  }

  set(key: string, state: AvailabilityState): void {
    this.cache.set(key, {
      state,
      observedAt: Date.now(),
    });
  }

  get(key: string, maxAgeMs: number = 15000): CachedAvailability | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    const age = Date.now() - entry.observedAt;
    if (age > maxAgeMs) {
      return undefined;
    }
    return entry;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  has(key: string, maxAgeMs: number = 15000): boolean {
    return this.get(key, maxAgeMs) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
