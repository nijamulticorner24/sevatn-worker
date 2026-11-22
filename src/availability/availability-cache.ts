import { AvailabilityState } from '../sabarimala/darshan-availability';
import { normalizeDate } from '../sabarimala/virtual-q';

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
    const lowerRoute = (route || '').toLowerCase();
    let routeCanonical = 'PAMBA';
    if (lowerRoute.includes('erumely')) {
      routeCanonical = 'ERUMELY';
    } else if (lowerRoute.includes('vandiperiyar') || lowerRoute.includes('sathram')) {
      routeCanonical = 'VANDIPERIYAR';
    } else if (lowerRoute.includes('pamba')) {
      routeCanonical = 'PAMBA';
    } else if (route && route.trim()) {
      routeCanonical = route.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 15);
    }
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
