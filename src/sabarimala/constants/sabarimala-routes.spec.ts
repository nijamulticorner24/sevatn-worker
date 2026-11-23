import {
  SabarimalaRoute,
  normalizeSabarimalaRoute,
  normalizeRouteCanonical,
  getOfficialSabarimalaRouteLabel,
  getOfficialSabarimalaRouteValue,
  isSameSabarimalaRoute,
  isRouteMatching,
} from './sabarimala-routes';
import { normalizeDemandKey } from '../../availability/demand-key';
import { resolveCanonicalRoute, OFFICIAL_PORTAL_ROUTES } from '../flows/date-route.flow';

describe('Worker Sabarimala Routes & Portal Flow Alignment', () => {
  it('correctly normalizes all aliases to canonical enums', () => {
    expect(normalizeSabarimalaRoute('Pamba Base')).toBe(SabarimalaRoute.PAMBA);
    expect(normalizeSabarimalaRoute('Erumeli Traditional')).toBe(SabarimalaRoute.ERUMELY);
    expect(normalizeSabarimalaRoute('Vandiperiyar / Pulmedu')).toBe(SabarimalaRoute.VANDIPERIYAR);
    expect(normalizeSabarimalaRoute('Nilakkal Shuttle')).toBeNull();
  });

  it('resolves correct official portal routes for worker automation', () => {
    const pambaDef = resolveCanonicalRoute('Pamba (Regular Footpath Route)');
    expect(pambaDef).not.toBeNull();
    expect(pambaDef?.officialValue).toBe('1');
    expect(pambaDef?.canonicalName).toBe('Pamba - Marakkoottam - 4 Kms');

    const erumeliDef = resolveCanonicalRoute('Erumeli Traditional');
    expect(erumeliDef).not.toBeNull();
    expect(erumeliDef?.officialValue).toBe('2');
    expect(erumeliDef?.canonicalName).toBe('Erumely - Kalaketti Traditional Path - 46 Kms');

    const vandiDef = resolveCanonicalRoute('Vandiperiyar / Pulmedu');
    expect(vandiDef).not.toBeNull();
    expect(vandiDef?.officialValue).toBe('3');
    expect(vandiDef?.canonicalName).toBe('Vandiperiyar - Sathram - Pulmedu - 16 Kms');
  });

  it('rejects unsupported routes in resolveCanonicalRoute', () => {
    expect(resolveCanonicalRoute('Nilakkal - Pamba Shuttle Route')).toBeNull();
    expect(resolveCanonicalRoute('Kottaiyadi Traditional Trek')).toBeNull();
    expect(resolveCanonicalRoute('Unknown Route')).toBeNull();
  });

  it('worker normalizeDemandKey agrees with API normalizeDemandKey', () => {
    const key1 = normalizeDemandKey('2027-01-02', 'Erumeli Traditional');
    const key2 = normalizeDemandKey('2027-01-02', 'Erumely - Kalaketti Traditional Path - 46 Kms');
    expect(key1).toBe('2027-01-02:ERUMELY');
    expect(key2).toBe('2027-01-02:ERUMELY');
    expect(key1).toBe(key2);
  });
});
