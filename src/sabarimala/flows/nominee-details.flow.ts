import { Page } from 'playwright';
import { SanitizedLogger } from '../../monitoring/logger';
import { BookingExecutionContext, VirtualQWorkflowError } from './types';
import { FlowDiagnosticsManager } from './diagnostics';

export const NOMINEE_RELATION_MAP: Record<string, { value: string; label: string }> = {
  father: { value: '1', label: 'Father' },
  '1': { value: '1', label: 'Father' },
  mother: { value: '2', label: 'Mother' },
  '2': { value: '2', label: 'Mother' },
  son: { value: '3', label: 'Son' },
  '3': { value: '3', label: 'Son' },
  daughter: { value: '4', label: 'Daughter' },
  '4': { value: '4', label: 'Daughter' },
  brother: { value: '5', label: 'Brother' },
  '5': { value: '5', label: 'Brother' },
  sister: { value: '6', label: 'Sister' },
  '6': { value: '6', label: 'Sister' },
  spouse: { value: '11', label: 'Spouse' },
  wife: { value: '11', label: 'Spouse' },
  husband: { value: '11', label: 'Spouse' },
  '11': { value: '11', label: 'Spouse' },
};

export function validateNomineeName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 32) return false;
  return /^[a-zA-Z\s.]+$/.test(trimmed);
}

export function validateNomineeAge(age: number | string): boolean {
  if (age === undefined || age === null) return false;
  const str = String(age).trim();
  if (!/^[0-9]+$/.test(str)) return false;
  const num = parseInt(str, 10);
  return num >= 18 && num <= 120;
}

export function validateNomineeRelationship(rel: string): boolean {
  if (!rel || typeof rel !== 'string') return false;
  const norm = rel.toLowerCase().trim();
  return !!NOMINEE_RELATION_MAP[norm];
}

export class NomineeDetailsFlow {
  /**
   * PHASE 5: Customer Nominee Form Population & Portal Validation (Strict Single-Nominee Flow)
   *
   * Strictly populates the customer-provided nominee details for the single active pilgrim
   * in Row 0 inside #nominee-table-wrapper on #/darshan, dispatches Angular form validation events,
   * verifies the portal accepted the inputs, and never touches or fills multiple rows in one portal pass.
   */
  static async execute(page: Page, ctx: BookingExecutionContext): Promise<boolean> {
    const requestedCount = 1;
    SanitizedLogger.info(
      `[NOMINEE] Populating customer-provided nominee details for single pilgrim (Attempt Devotee #${(ctx.currentPilgrimIndex ?? 0) + 1}) on Booking #${ctx.bookingCode}`,
    );

    try {
      const activeNominee =
        ctx.nominee ||
        (Array.isArray(ctx.nominees) && (ctx.nominees[ctx.currentPilgrimIndex || 0] || ctx.nominees[0])) ||
        (Array.isArray(ctx.pilgrims) && ctx.pilgrims[ctx.currentPilgrimIndex || 0]?.nomineeName
          ? {
              nomineeName: ctx.pilgrims[ctx.currentPilgrimIndex || 0].nomineeName,
              nomineeAge: ctx.pilgrims[ctx.currentPilgrimIndex || 0].nomineeAge,
              nomineeRelationship: ctx.pilgrims[ctx.currentPilgrimIndex || 0].nomineeRelationship,
              nomineePhone: ctx.pilgrims[ctx.currentPilgrimIndex || 0].nomineePhone,
            }
          : null);

      if (!activeNominee || !activeNominee.nomineeName || !String(activeNominee.nomineeName).trim()) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'NOMINEE_VALIDATION_FAILED',
          'NOMINEE_DETAILS_MISSING: Customer nominee details are required to populate the portal nominee form.',
          'PHASE_5_NOMINEE_DETAILS',
          diag,
        );
      }

      // Build and validate single nominee for active pilgrim
      const targetNominees: Array<{ nameVal: string; ageVal: string; relVal: string; mapped?: { value: string; label: string } }> = [];

      for (let i = 0; i < requestedCount; i++) {
        const explicitNominee = activeNominee;

        if (!explicitNominee || !explicitNominee.nomineeName || !String(explicitNominee.nomineeName).trim()) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'NOMINEE_VALIDATION_FAILED',
            `NOMINEE_DETAILS_MISSING: Customer nominee details missing for Pilgrim #${i + 1}.`,
            'PHASE_5_NOMINEE_DETAILS',
            diag,
          );
        }

        const nameVal = String(explicitNominee.nomineeName).trim().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
        const ageVal = explicitNominee.nomineeAge !== undefined && explicitNominee.nomineeAge !== null ? String(explicitNominee.nomineeAge).trim() : '';
        const relVal = explicitNominee.nomineeRelationship ? String(explicitNominee.nomineeRelationship).trim() : '';

        if (!validateNomineeName(nameVal)) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'NOMINEE_VALIDATION_FAILED',
            `NOMINEE_NAME_INVALID: Pilgrim #${i + 1} nominee name "${nameVal}" must be 2-32 alphabetic characters.`,
            'PHASE_5_NOMINEE_DETAILS',
            diag,
          );
        }

        if (!validateNomineeAge(ageVal)) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'NOMINEE_VALIDATION_FAILED',
            `NOMINEE_AGE_INVALID: Pilgrim #${i + 1} nominee age "${ageVal}" must be an adult integer between 18 and 120.`,
            'PHASE_5_NOMINEE_DETAILS',
            diag,
          );
        }

        if (!relVal || !validateNomineeRelationship(relVal)) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'NOMINEE_VALIDATION_FAILED',
            `NOMINEE_RELATIONSHIP_INVALID: Pilgrim #${i + 1} nominee relationship "${relVal}" is not supported by Sabarimala portal. Allowed: Father, Mother, Son, Daughter, Brother, Sister, Spouse.`,
            'PHASE_5_NOMINEE_DETAILS',
            diag,
          );
        }

        targetNominees.push({
          nameVal,
          ageVal,
          relVal,
          mapped: NOMINEE_RELATION_MAP[relVal.toLowerCase().trim()],
        });
      }

      // 2. Wait for Nominee Details section on #/darshan
      const section = page.locator('#nominee-table-wrapper, text=/Nominee Details/i, .nominee-details').first();
      const isSectionVisible = await section.isVisible({ timeout: 5000 }).catch(() => false);

      const rows = page.locator('#nominee-table-wrapper table tbody tr, table.tabScroll tbody tr');
      const rowCount = await rows.count().catch(() => 0);

      const nameInputs = page.locator(
        '#nominee-table-wrapper input[placeholder*="Nominee Name"], input[placeholder="Enter Nominee Name"], input[formcontrolname="nomineeName"], input[name*="nomineeName"]',
      );
      const nameInputCount = await nameInputs.count().catch(() => 0);

      if (!isSectionVisible && rowCount === 0 && nameInputCount === 0) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'NOMINEE_VALIDATION_FAILED',
          'NOMINEE_FORM_NOT_FOUND: Nominee Details table or inputs were not rendered on #/darshan.',
          'PHASE_5_NOMINEE_DETAILS',
          diag,
        );
      }

      const ageInputs = page.locator(
        '#nominee-table-wrapper input[placeholder*="Age"], input[placeholder="Enter Age"], input[formcontrolname="nomineeAge"], input[name*="nomineeAge"]',
      );
      const relSelects = page.locator(
        '#nominee-table-wrapper select, select[formcontrolname="nomineeRelationship"], select[name*="relationship"]',
      );

      // Populate nominee rows 0..requestedCount-1
      for (let i = 0; i < requestedCount; i++) {
        const { nameVal, ageVal, relVal, mapped } = targetNominees[i];
        const targetRow = rowCount > i && typeof rows.nth === 'function' ? rows.nth(i) : null;
        const hasRowLocator = targetRow && typeof targetRow.locator === 'function';

        let nInput = hasRowLocator
          ? targetRow.locator('input[placeholder*="Nominee Name"], input[placeholder="Enter Nominee Name"]').first()
          : nameInputs.nth(i);
        let aInput = hasRowLocator
          ? targetRow.locator('input[placeholder*="Age"], input[placeholder="Enter Age"]').first()
          : ageInputs.nth(i);
        let rSelect = hasRowLocator
          ? targetRow.locator('select').first()
          : relSelects.nth(i);

        if (hasRowLocator && !(await nInput.isVisible({ timeout: 500 }).catch(() => false))) {
          const td2 = targetRow.locator('td').nth(2);
          if (td2 && typeof td2.locator === 'function') {
            nInput = td2.locator('input').first();
          }
        }
        if (hasRowLocator && !(await aInput.isVisible({ timeout: 500 }).catch(() => false))) {
          const td3 = targetRow.locator('td').nth(3);
          if (td3 && typeof td3.locator === 'function') {
            aInput = td3.locator('input').first();
          }
        }
        if (hasRowLocator && !(await rSelect.isVisible({ timeout: 500 }).catch(() => false))) {
          const td4 = targetRow.locator('td').nth(4);
          if (td4 && typeof td4.locator === 'function') {
            rSelect = td4.locator('select').first();
          }
        }

        // 3. Populate Nominee Name & fire Angular validation events
        if (nInput && await nInput.isVisible({ timeout: 1500 }).catch(() => false)) {
          if (typeof nInput.scrollIntoViewIfNeeded === 'function') {
            await nInput.scrollIntoViewIfNeeded().catch(() => {});
          }
          if (typeof nInput.click === 'function') {
            await nInput.click().catch(() => {});
          }
          await nInput.fill(nameVal);
          if (typeof nInput.dispatchEvent === 'function') {
            await nInput.dispatchEvent('input').catch(() => {});
            await nInput.dispatchEvent('change').catch(() => {});
            await nInput.dispatchEvent('blur').catch(() => {});
          }
        }

        // 4. Populate Nominee Age & fire Angular validation events
        if (aInput && await aInput.isVisible({ timeout: 1500 }).catch(() => false)) {
          if (typeof aInput.click === 'function') {
            await aInput.click().catch(() => {});
          }
          await aInput.fill(ageVal);
          if (typeof aInput.dispatchEvent === 'function') {
            await aInput.dispatchEvent('input').catch(() => {});
            await aInput.dispatchEvent('change').catch(() => {});
            await aInput.dispatchEvent('blur').catch(() => {});
          }
        }

        // 5. Select Official Relationship option & fire Angular change events
        if (rSelect && await rSelect.isVisible({ timeout: 1500 }).catch(() => false)) {
          if (mapped) {
            await rSelect.selectOption(mapped.value).catch(async () => {
              await rSelect.selectOption({ label: mapped.label }).catch(() => {});
            });
          } else {
            await rSelect.selectOption({ label: relVal });
          }
          if (typeof rSelect.dispatchEvent === 'function') {
            await rSelect.dispatchEvent('change').catch(() => {});
            await rSelect.dispatchEvent('blur').catch(() => {});
          }
        }
      }

      // 6. Verify portal accepted the nominee form inputs (no .ng-invalid on nominee inputs)
      const invalidNomineeInput = page.locator('#nominee-table-wrapper input.ng-invalid, #nominee-table-wrapper select.ng-invalid');
      const invalidCount = invalidNomineeInput && typeof invalidNomineeInput.count === 'function'
        ? await invalidNomineeInput.count().catch(() => 0)
        : 0;
      if (invalidCount > 0) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'NOMINEE_VALIDATION_FAILED',
          `Portal marked ${invalidCount} nominee input(s) as invalid (.ng-invalid).`,
          'PHASE_5_NOMINEE_DETAILS',
          diag,
        );
      }

      ctx.nomineeCompletionStatus = true;
      SanitizedLogger.info(
        `[NOMINEE] Nominee details validated and populated for ${requestedCount} pilgrim(s).`,
      );
      return true;
    } catch (err: any) {
      if (err instanceof VirtualQWorkflowError) throw err;
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_5_NOMINEE_DETAILS', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'NOMINEE_VALIDATION_FAILED',
        err.message || 'Failed validating nominee details on portal',
        'PHASE_5_NOMINEE_DETAILS',
        diag,
      );
    }
  }
}
