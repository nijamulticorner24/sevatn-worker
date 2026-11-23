import { normalizeRouteCanonical } from '../sabarimala/constants/sabarimala-routes';

/**
 * Normalizes a target date, route, and criteria into an authoritative discovery demand key.
 * Format: YYYY-MM-DD:ROUTE_CANONICAL (e.g. 2026-11-27:PAMBA)
 */
export function normalizeDemandKey(date: string | Date, route: string, criteria?: string): string {
  const dateStr = typeof date === 'string'
    ? date.trim().split('T')[0]
    : date.toISOString().split('T')[0];

  const routeCanonical = normalizeRouteCanonical(route);

  const baseKey = `${dateStr}:${routeCanonical}`;
  if (criteria && criteria.trim()) {
    return `${baseKey}:${criteria.trim().toUpperCase()}`;
  }
  return baseKey;
}

/**
 * Authoritatively parses a demandKey into its date, route, and optional criteria portions.
 * Key formats supported:
 *  - Canonical: YYYY-MM-DD:ROUTE (e.g. 2026-11-22:PAMBA)
 *  - Extended:  YYYY-MM-DD:ROUTE:CRITERIA
 *  - Legacy:    YYYY-MM-DD|ROUTE|CRITERIA
 */
export function parseDemandKey(key: string): { date: string; route: string; criteria?: string } {
  if (!key) {
    return { date: '', route: '' };
  }

  // Split by ':' (canonical) or '|' (legacy fallback)
  const delimiter = key.includes(':') ? ':' : '|';
  const parts = key.split(delimiter);
  const rawDate = parts[0]?.trim() || '';
  const rawRoute = parts[1]?.trim() || '';
  const rawCriteria = parts[2]?.trim() || undefined;

  let parsedDate = rawDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    parsedDate = rawDate;
  } else {
    const ddmmyyyy = rawDate.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (ddmmyyyy) {
      parsedDate = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
    }
  }

  const result: { date: string; route: string; criteria?: string } = {
    date: parsedDate,
    route: rawRoute,
  };
  if (rawCriteria) {
    result.criteria = rawCriteria;
  }
  return result;
}

