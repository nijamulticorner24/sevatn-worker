import { normalizeDemandKey, parseDemandKey } from './demand-key';

describe('DemandKey Normalization and Parsing Suite', () => {
  it('parses demandKey with format YYYY-MM-DD:ROUTE correctly', () => {
    const parsed = parseDemandKey('2026-11-22:PAMBA');
    expect(parsed).toEqual({ date: '2026-11-22', route: 'PAMBA' });
  });

  it('parses demandKey with criteria YYYY-MM-DD:ROUTE:CRITERIA', () => {
    const parsed = parseDemandKey('2026-11-25:ERUMELY:AFTERNOON');
    expect(parsed).toEqual({ date: '2026-11-25', route: 'ERUMELY', criteria: 'AFTERNOON' });
  });

  it('supports legacy pipe-separated demandKey format', () => {
    const parsed = parseDemandKey('2026-12-10|Pamba|VIP');
    expect(parsed).toEqual({ date: '2026-12-10', route: 'Pamba', criteria: 'VIP' });
  });

  it('normalizes and round-trips demand key', () => {
    const normalized = normalizeDemandKey('2026-11-22', 'Pamba - Marakkoottam - 4 Kms');
    expect(normalized).toBe('2026-11-22:PAMBA');
    const parsed = parseDemandKey(normalized);
    expect(parsed).toEqual({ date: '2026-11-22', route: 'PAMBA' });
  });

  it('handles empty or malformed strings gracefully', () => {
    expect(parseDemandKey('')).toEqual({ date: '', route: '' });
    expect(parseDemandKey('invalid-key')).toEqual({ date: 'invalid-key', route: '' });
  });
});
