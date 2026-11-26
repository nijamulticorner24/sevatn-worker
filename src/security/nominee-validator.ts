export interface NomineeValidationResult {
  valid: boolean;
  errors: string[];
  resolvedNominee?: {
    nomineeName: string;
    nomineeAge: number;
    nomineeRelationship: string;
    nomineePhone?: string;
  };
}

export const OFFICIAL_SABARIMALA_RELATIONSHIPS = [
  'Father',
  'Mother',
  'Son',
  'Daughter',
  'Brother',
  'Sister',
  'Spouse',
] as const;

export function normalizeNomineeRelationship(rawRel?: string | null): string | null {
  if (!rawRel) return null;
  const clean = rawRel.trim().toLowerCase();
  const map: Record<string, string> = {
    father: 'Father',
    '1': 'Father',
    mother: 'Mother',
    '2': 'Mother',
    son: 'Son',
    '3': 'Son',
    daughter: 'Daughter',
    '4': 'Daughter',
    brother: 'Brother',
    '5': 'Brother',
    sister: 'Sister',
    '6': 'Sister',
    spouse: 'Spouse',
    wife: 'Spouse',
    husband: 'Spouse',
    '11': 'Spouse',
  };
  return map[clean] || null;
}

/**
 * Validates mandatory nominee details for pilgrim insurance.
 * Redacts identity information in error diagnostics.
 */
export function validateNominee(bookingOrContext: {
  nominee?: any;
  nominees?: any[];
  nomineeName?: string;
  nomineeAge?: number;
  nomineeRelationship?: string;
  nomineePhone?: string;
  pilgrims?: any[];
  preferences?: any;
}): NomineeValidationResult {
  const errors: string[] = [];

  const primaryNominee =
    bookingOrContext.nominee ||
    (Array.isArray(bookingOrContext.nominees) && bookingOrContext.nominees[0]) ||
    (Array.isArray(bookingOrContext.preferences?.nominees) && bookingOrContext.preferences.nominees[0]) ||
    (bookingOrContext.nomineeName
      ? {
          nomineeName: bookingOrContext.nomineeName,
          nomineeAge: bookingOrContext.nomineeAge,
          nomineeRelationship: bookingOrContext.nomineeRelationship,
          nomineePhone: bookingOrContext.nomineePhone,
        }
      : null) ||
    (Array.isArray(bookingOrContext.pilgrims) && bookingOrContext.pilgrims[0]?.nominee) ||
    (Array.isArray(bookingOrContext.pilgrims) && bookingOrContext.pilgrims[0]?.nomineeName
      ? {
          nomineeName: bookingOrContext.pilgrims[0].nomineeName,
          nomineeAge: bookingOrContext.pilgrims[0].nomineeAge,
          nomineeRelationship: bookingOrContext.pilgrims[0].nomineeRelationship,
          nomineePhone: bookingOrContext.pilgrims[0].nomineePhone,
        }
      : null);

  if (!primaryNominee) {
    errors.push('Mandatory nominee details missing: Name, age (>=18), and relationship are required.');
    return { valid: false, errors };
  }

  const name = (primaryNominee.nomineeName || primaryNominee.fullName)?.trim();
  if (!name || name.length < 2) {
    errors.push('Nominee name must be at least 2 characters.');
  }

  const age = Number(primaryNominee.nomineeAge ?? primaryNominee.age);
  if (!age || isNaN(age) || age < 18 || age > 120) {
    errors.push('Nominee must be an adult with a valid age between 18 and 120.');
  }

  const rawRel = (primaryNominee.nomineeRelationship ?? primaryNominee.relationship)?.trim();
  const normalizedRel = normalizeNomineeRelationship(rawRel);
  if (!rawRel || rawRel.length < 2) {
    errors.push('Nominee relationship is required.');
  } else if (!normalizedRel) {
    errors.push(`Nominee relationship "${rawRel}" is not supported by Sabarimala portal. Allowed: ${OFFICIAL_SABARIMALA_RELATIONSHIPS.join(', ')}.`);
  }

  // Validate any additional nominees in nominees array if provided
  const rawNominees = Array.isArray(bookingOrContext.nominees) && bookingOrContext.nominees.length > 0
    ? bookingOrContext.nominees
    : Array.isArray(bookingOrContext.preferences?.nominees) && bookingOrContext.preferences.nominees.length > 0
      ? bookingOrContext.preferences.nominees
      : [];

  rawNominees.forEach((n, idx) => {
    if (!n) {
      errors.push(`Pilgrim #${idx + 1} nominee details are missing.`);
      return;
    }
    const nName = (n.nomineeName || n.fullName)?.trim();
    const nAge = Number(n.nomineeAge ?? n.age);
    const nRel = (n.nomineeRelationship ?? n.relationship)?.trim();
    const nRelNorm = normalizeNomineeRelationship(nRel);
    if (!nName || nName.length < 2) {
      errors.push(`Pilgrim #${idx + 1} nominee name must be at least 2 characters.`);
    }
    if (!nAge || isNaN(nAge) || nAge < 18 || nAge > 120) {
      errors.push(`Pilgrim #${idx + 1} nominee must be an adult with a valid age between 18 and 120.`);
    }
    if (!nRel || nRel.length < 2) {
      errors.push(`Pilgrim #${idx + 1} nominee relationship is required.`);
    } else if (!nRelNorm) {
      errors.push(`Pilgrim #${idx + 1} nominee relationship "${nRel}" is not supported by Sabarimala portal. Allowed: ${OFFICIAL_SABARIMALA_RELATIONSHIPS.join(', ')}.`);
    }
  });

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    resolvedNominee: valid
      ? {
          nomineeName: name,
          nomineeAge: age,
          nomineeRelationship: normalizedRel || rawRel,
          nomineePhone: (primaryNominee.nomineePhone ?? primaryNominee.phone)?.trim(),
        }
      : undefined,
  };
}


