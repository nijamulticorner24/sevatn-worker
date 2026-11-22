import { AvailabilityCache } from './availability-cache';

describe('AvailabilityCache (PR #4 / GAP-04)', () => {
  let cache: AvailabilityCache;

  beforeEach(() => {
    cache = new AvailabilityCache();
  });

  it('stores and retrieves availability state with default 15s TTL', () => {
    const key = AvailabilityCache.buildKey('2026-11-20', 'Pamba');
    cache.set(key, 'AVAILABLE');

    const result = cache.get(key);
    expect(result).toBeDefined();
    expect(result?.state).toBe('AVAILABLE');
    expect(result?.observedAt).toBeLessThanOrEqual(Date.now());
  });

  it('returns undefined when entry is older than maxAgeMs', () => {
    const key = AvailabilityCache.buildKey('2026-11-20', 'Pamba');
    cache.set(key, 'FULL');

    // Simulate entry older than 15,000ms
    const entry = (cache as any).cache.get(key);
    entry.observedAt = Date.now() - 16000;

    expect(cache.get(key, 15000)).toBeUndefined();
    // But with larger maxAgeMs, it is still retrievable
    expect(cache.get(key, 30_000)?.state).toBe('FULL');
  });

  it('deletes an entry from cache', () => {
    const key = '2026-11-20_PAMBA';
    cache.set(key, 'DISABLED');
    expect(cache.has(key)).toBe(true);

    cache.delete(key);
    expect(cache.get(key)).toBeUndefined();
    expect(cache.has(key)).toBe(false);
  });

  it('clears all entries from cache', () => {
    cache.set('key1', 'AVAILABLE');
    cache.set('key2', 'FULL');
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('buildKey formats canonical date and route consistently', () => {
    expect(AvailabilityCache.buildKey('2026-11-20', 'Pamba - Marakkoottam - 4 Kms')).toBe('2026-11-20_PAMBA');
    expect(AvailabilityCache.buildKey('20-11-2026', 'Erumely Traditional Path')).toBe('2026-11-20_ERUMELY');
    expect(AvailabilityCache.buildKey('2026-11-20', 'Vandiperiyar Route')).toBe('2026-11-20_VANDIPERIYAR');
  });
});
