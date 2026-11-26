import { Page } from 'playwright';
import * as crypto from 'crypto';
import { SanitizedLogger } from '../../monitoring/logger';
import { BookingExecutionContext, SelectedPilgrimEvidence, VirtualQWorkflowError } from './types';
import { FlowDiagnosticsManager } from './diagnostics';

export class PilgrimSelectionFlow {
  /**
   * Computes a deterministic SHA-256 identity fingerprint for a saved pilgrim row.
   * Does not rely solely on display name: combines accountId, portalPilgrimId, normalized name, gender, idType, and masked ID tail.
   */
  static computePilgrimFingerprint(params: {
    accountId?: string;
    portalPilgrimId?: string;
    fullName?: string;
    gender?: string;
    idType?: string;
    maskedIdNumber?: string;
    rowIndex?: number;
  }): string {
    const accountId = (params.accountId || 'acct').trim().toLowerCase();
    const portalId = (params.portalPilgrimId || '').trim().toLowerCase();
    const fullNameNorm = (params.fullName || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .trim();
    const genderNorm = (params.gender || '').toUpperCase().trim().slice(0, 1);
    const idTypeNorm = (params.idType || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .trim();
    const maskedTail = (params.maskedIdNumber || '')
      .replace(/[^A-Z0-9]/gi, '')
      .toUpperCase()
      .slice(-4);

    const seed = `${accountId}|${portalId}|${fullNameNorm}|${genderNorm}|${idTypeNorm}|${maskedTail || params.rowIndex || 0}`;
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
  }

  /**
   * Helper: Evaluates whether a checkbox element or Angular Material checkbox is currently checked.
   */
  private static async isCheckboxChecked(cb: any): Promise<boolean> {
    if (!cb || typeof cb.evaluate !== 'function') return false;
    return await cb
      .evaluate((el: HTMLElement) => {
        if (!el) return false;
        if (el instanceof HTMLInputElement) return el.checked;
        return (
          el.classList?.contains('mat-checkbox-checked') ||
          el.classList?.contains('mat-mdc-checkbox-checked') ||
          el.getAttribute?.('aria-checked') === 'true' ||
          !!el.querySelector?.('.mat-checkbox-checked, .mat-mdc-checkbox-checked') ||
          !!(el.querySelector?.('input[type="checkbox"]') as HTMLInputElement)?.checked
        );
      })
      .catch(() => false);
  }

  /**
   * Helper: Clicks a checkbox or its inner clickable label/container.
   */
  private static async toggleCheckbox(cb: any, page: Page): Promise<void> {
    if (!cb) return;
    if (typeof cb.locator === 'function') {
      const clickable = cb.locator('label, .mat-checkbox-inner-container, input[type="checkbox"]').first();
      if (await clickable.isVisible({ timeout: 400 }).catch(() => false)) {
        await clickable.click({ force: false }).catch(async () => {
          await cb.click({ force: false }).catch(() => {});
        });
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(300).catch(() => {});
        }
        return;
      }
    }
    if (typeof cb.click === 'function') {
      await cb.click({ force: false }).catch(() => {});
    }
    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(300).catch(() => {});
    }
  }

  /**
   * PHASE 4: Canonical Saved-Pilgrim Selection Workflow (Strict Single-Pilgrim Selection)
   *
   * Strict Business Rules:
   * - One Portal Booking Attempt = EXACTLY ONE selected saved pilgrim from the Sabarimala account + 1 nominee.
   * - NEVER select multiple saved pilgrims together.
   * - NEVER check multiple checkboxes in one attempt.
   * - Skip any saved pilgrim whose identityFingerprint is in ctx.excludedPilgrimFingerprints (already booked for this date/period or in this booking request).
   * - Enforce totalCheckedCount === 1 invariant strictly.
   */
  static async execute(
    page: Page,
    ctx: BookingExecutionContext,
  ): Promise<{
    success: boolean;
    selectedCount: number;
    selectedPilgrim: SelectedPilgrimEvidence;
    selectedPilgrims: SelectedPilgrimEvidence[];
  }> {
    // Strict invariant: Regardless of parent requested quantity, each portal attempt selects exactly 1 saved pilgrim
    const requestedCount = 1;
    ctx.pilgrimCount = 1;
    SanitizedLogger.info(
      `[PILGRIM-SELECTION] Initiating strict single-pilgrim selection (Attempt Pilgrim #${(ctx.currentPilgrimIndex ?? 0) + 1}) for Booking #${ctx.bookingCode}`,
    );

    try {
      const excludedFingerprints = new Set(ctx.excludedPilgrimFingerprints || []);

      // Step 1: Open the pilgrim selection modal/table from #/darshan
      const selectPilgrimBtn = page
        .locator('button:has-text("Select Pilgrim"), a:has-text("Select Pilgrim"), .btn-select-pilgrim, button:has-text("Add Pilgrim")')
        .first();

      if (await selectPilgrimBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await selectPilgrimBtn.click();
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(1500);
        }
      }

      // Step 2: Wait for saved pilgrim table
      if (typeof page.waitForSelector === 'function') {
        await page.waitForSelector('table, mat-table, .pilgrim-card', { timeout: 10000 }).catch(() => {});
      }

      const rows = page.locator('table tbody tr, mat-row');
      const rowCount = await rows.count().catch(() => 0);
      SanitizedLogger.info(`[PILGRIM-SELECTION] Found ${rowCount} saved pilgrim record(s) in official account`);

      if (rowCount === 0) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_4_PILGRIM_SELECTION', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PILGRIM_SELECTION_FAILED',
          'No saved pilgrims found in official portal account. Please register at least one pilgrim in the Sabarimala account.',
          'PHASE_4_PILGRIM_SELECTION',
          diag,
        );
      }

      // Step 3: Parse all saved pilgrim rows and ensure any pre-checked checkboxes are unchecked first
      interface ParsedRow {
        index: number;
        row: any;
        cb: any;
        evidence: SelectedPilgrimEvidence;
      }

      const candidateRows: ParsedRow[] = [];

      for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i);
        const cb = row.locator('mat-checkbox, input[type="checkbox"]').first();
        const isCbVisible = await cb.isVisible({ timeout: 1000 }).catch(() => false);
        if (!isCbVisible) continue;

        // If already checked before our selection, uncheck it so we never select > 1 pilgrim
        const initiallyChecked = await this.isCheckboxChecked(cb);
        if (initiallyChecked) {
          await this.toggleCheckbox(cb, page);
        }

        // Extract identity columns from row cells
        const rawText = (await row.innerText().catch(() => '')).trim();
        const cells = rawText
          .split(/\t|\n/)
          .map((c: string) => c.trim())
          .filter(Boolean);

        const portalPilgrimId =
          (typeof cb.getAttribute === 'function' ? await cb.getAttribute('id').catch(() => null) : null) ||
          (typeof cb.getAttribute === 'function' ? await cb.getAttribute('value').catch(() => null) : null) ||
          undefined;

        // Typical columns: [S.No?, FullName, Age/DOB, Gender, IDType, IDNumber]
        const nonNumericCells = cells.filter((c: string) => !/^\d{1,2}$/.test(c));
        const fullName = nonNumericCells[0] || cells[0] || `Pilgrim #${i + 1}`;
        const genderMatch = rawText.match(/\b(Male|Female|Transgender|Other)\b/i);
        const gender = genderMatch ? genderMatch[1] : undefined;
        const idTypeMatch = rawText.match(/\b(Aadhaar|Aadhar|Passport|Voter\s*ID)\b/i);
        const idType = idTypeMatch ? idTypeMatch[1].toUpperCase().replace(/\s+/g, '_') : undefined;
        const ageMatch = rawText.match(/\b(1[0-1]\d|[1-9]\d|\d)\b/);
        const age = ageMatch ? parseInt(ageMatch[1], 10) : undefined;
        const idTailMatch = rawText.match(/([X*•]{4,}[\s-]*\d{3,4}|\b[A-Z0-9]{4,16}\b)$/i);
        const maskedIdNumber = idTailMatch ? idTailMatch[1].trim() : undefined;

        const identityFingerprint = this.computePilgrimFingerprint({
          accountId: ctx.accountId,
          portalPilgrimId,
          fullName,
          gender,
          idType,
          maskedIdNumber,
          rowIndex: i + 1,
        });

        candidateRows.push({
          index: i,
          row,
          cb,
          evidence: {
            name: fullName,
            fullName,
            age,
            gender,
            idType,
            maskedIdNumber,
            portalPilgrimId,
            identityFingerprint,
            rowNumber: i + 1,
          },
        });
      }

      if (candidateRows.length === 0) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_4_PILGRIM_SELECTION', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PILGRIM_SELECTION_FAILED',
          'No selectable pilgrim checkboxes found in official account table.',
          'PHASE_4_PILGRIM_SELECTION',
          diag,
        );
      }

      // Step 4: Filter out any saved pilgrim already booked or confirmed
      const confirmedDevoteeList = ctx.confirmedDevotees || [];
      const eligibleRows: ParsedRow[] = [];

      for (const cand of candidateRows) {
        // Check if candidate matches any confirmed devotee by fingerprint or normalized name
        const candNormName = (cand.evidence.fullName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchedConfirmed = confirmedDevoteeList.find((cd) => {
          if (cd.fingerprint && cand.evidence.identityFingerprint && cd.fingerprint === cand.evidence.identityFingerprint) {
            return true;
          }
          const cdNormName = (cd.fullName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!cdNormName || !candNormName) return false;
          return cdNormName === candNormName || candNormName.includes(cdNormName) || cdNormName.includes(candNormName);
        });

        if (matchedConfirmed) {
          SanitizedLogger.warn(
            `[DUPLICATE-DEVOTEE-BLOCKED]\nbookingId=${ctx.bookingCode}\ndevoteeSequence=${matchedConfirmed.sequence || 1}\ndevoteeName=${matchedConfirmed.fullName}\nreason=ALREADY_CONFIRMED\naction=SKIP_AND_SELECT_NEXT_PENDING`,
          );
          continue; // Permanently skip confirmed devotee
        }

        // Check if candidate fingerprint was excluded in context
        if (cand.evidence.identityFingerprint && excludedFingerprints.has(cand.evidence.identityFingerprint)) {
          continue;
        }

        eligibleRows.push(cand);
      }

      if (eligibleRows.length === 0) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_4_PILGRIM_SELECTION', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PREVIOUS_BOOKING_RESTRICTION',
          `All ${candidateRows.length} saved pilgrim(s) in this account already have a confirmed booking or are excluded for ${ctx.requestedDate}. Duplicate pilgrim booking prevented.`,
          'PHASE_4_PILGRIM_SELECTION',
          diag,
        );
      }

      // Step 5: Select the target pending devotee using verified profile mapping
      const targetDevotee: any = ctx.targetDevotee || (Array.isArray(ctx.pilgrims) && ctx.pilgrims[0]);
      const targetSeq = targetDevotee?.sequence || (ctx.currentPilgrimIndex !== undefined ? ctx.currentPilgrimIndex + 1 : 1);
      const targetName = targetDevotee?.fullName || `Devotee #${targetSeq}`;
      const targetId = targetDevotee?.id || `devotee-${targetSeq}`;
      const targetNameNorm = String(targetName).toLowerCase().replace(/[^a-z0-9]/g, '');
      const isGenericName = !targetNameNorm || targetNameNorm.startsWith('devotee') || targetNameNorm.startsWith('pilgrim');

      const chosenCandidates: ParsedRow[] = [];
      const chosenIndices = new Set<number>();

      // 1. Prefer explicit name match in eligible unconfirmed rows
      if (!isGenericName) {
        const matchedCandidate = eligibleRows.find((r) => {
          const rowNorm = (r.evidence.fullName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return rowNorm && (rowNorm === targetNameNorm || rowNorm.includes(targetNameNorm) || targetNameNorm.includes(rowNorm));
        });
        if (matchedCandidate) {
          chosenCandidates.push(matchedCandidate);
          chosenIndices.add(matchedCandidate.index);
        }
      }

      // 2. Fallback to first available unconfirmed eligible row
      if (chosenCandidates.length === 0 && eligibleRows.length > 0) {
        const fallbackCand = eligibleRows[0];
        chosenCandidates.push(fallbackCand);
        chosenIndices.add(fallbackCand.index);
      }

      if (chosenCandidates.length !== requestedCount) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_4_PILGRIM_SELECTION', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PILGRIM_SELECTION_FAILED',
          `Could not resolve eligible saved pilgrim for Devotee #${targetSeq} (${targetName}). Total eligible available: ${eligibleRows.length}.`,
          'PHASE_4_PILGRIM_SELECTION',
          diag,
        );
      }

      const selectedCand = chosenCandidates[0];
      SanitizedLogger.info(
        `[PILGRIM-SELECTION]\nbookingId=${ctx.bookingCode}\ndevoteeSequence=${targetSeq}\ndevoteeName=${targetName}\nstableDevoteeId=${targetId}\nsavedProfileMatch=${selectedCand.evidence.fullName} (Row ${selectedCand.evidence.rowNumber})\nalreadyConfirmed=false`,
      );

      // Step 5: Check EXACTLY requestedCount saved pilgrim checkboxes
      const confirmedCheckedIndices = new Set<number>();
      for (const chosenCandidate of chosenCandidates) {
        await this.toggleCheckbox(chosenCandidate.cb, page);

        // Verify checkbox transitioned to checked
        let isChosenChecked = await this.isCheckboxChecked(chosenCandidate.cb);
        if (!isChosenChecked && typeof chosenCandidate.cb?.isChecked === 'function') {
          isChosenChecked = await chosenCandidate.cb.isChecked().catch(() => false);
        }
        if (!isChosenChecked) {
          // Retry click once
          await this.toggleCheckbox(chosenCandidate.cb, page);
          isChosenChecked = await this.isCheckboxChecked(chosenCandidate.cb);
          if (!isChosenChecked && typeof chosenCandidate.cb?.isChecked === 'function') {
            isChosenChecked = await chosenCandidate.cb.isChecked().catch(() => false);
          }
        }

        if (!isChosenChecked) {
          const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_4_PILGRIM_SELECTION', ctx.bookingCode);
          throw new VirtualQWorkflowError(
            'PILGRIM_SELECTION_FAILED',
            `Failed to check checkbox for saved pilgrim "${chosenCandidate.evidence.fullName}" (Row ${chosenCandidate.evidence.rowNumber}).`,
            'PHASE_4_PILGRIM_SELECTION',
            diag,
          );
        }
        confirmedCheckedIndices.add(chosenCandidate.index);
      }

      // Verify no other rows are checked and exact requestedCount invariant holds
      let totalCheckedCount = 0;
      for (const cand of candidateRows) {
        const isChosen = chosenIndices.has(cand.index);
        let checked = await this.isCheckboxChecked(cand.cb);
        if (!checked && isChosen && confirmedCheckedIndices.has(cand.index)) {
          checked = true;
        }
        if (checked) {
          if (!isChosen) {
            SanitizedLogger.warn(
              `[PILGRIM-SELECTION] Unchecking extra row ${cand.index + 1} to enforce exact ${requestedCount}-pilgrim invariant`,
            );
            await this.toggleCheckbox(cand.cb, page);
          } else {
            totalCheckedCount++;
          }
        }
      }

      if (totalCheckedCount !== requestedCount) {
        const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_4_PILGRIM_SELECTION', ctx.bookingCode);
        throw new VirtualQWorkflowError(
          'PILGRIM_SELECTION_FAILED',
          `Pilgrim selection count invariant failed: expected ${requestedCount} checked pilgrim(s), found ${totalCheckedCount}.`,
          'PHASE_4_PILGRIM_SELECTION',
          diag,
        );
      }

      const selectedEvidenceList = chosenCandidates.map((c) => {
        c.evidence.verifiedInForm = true;
        return c.evidence;
      });
      const primaryChosen = selectedEvidenceList[0];

      SanitizedLogger.info(
        `[PILGRIM-SELECTION] Selected exactly ${requestedCount} saved pilgrim(s) out of ${rowCount} total: ${selectedEvidenceList
          .map((e) => `"${e.fullName}" (Row ${e.rowNumber}, FP: ${e.identityFingerprint})`)
          .join(', ')}`,
      );

      // Step 6: Click Submit / OK button to confirm pilgrim selection
      const submitBtn = page
        .locator(
          'button:has-text("Submit"), button:has-text("OK"), button:has-text("Confirm"), button:has-text("Done"), button:has-text("Apply"), button:has-text("Add to Booking"), button[type="submit"]',
        )
        .first();

      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitBtn.click();
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(1500);
        }
      }

      // Step 7: Wait for return to #/darshan
      if (typeof page.waitForURL === 'function') {
        await page.waitForURL(/darshan/i, { timeout: 5000 }).catch(() => {});
      }
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(800);
      }

      ctx.pilgrimCount = requestedCount;
      ctx.selectedPilgrim = primaryChosen;
      ctx.selectedPilgrims = selectedEvidenceList;

      return {
        success: true,
        selectedCount: requestedCount,
        selectedPilgrim: primaryChosen,
        selectedPilgrims: selectedEvidenceList,
      };
    } catch (err: any) {
      if (err instanceof VirtualQWorkflowError) throw err;
      const diag = await FlowDiagnosticsManager.captureDiagnostics(page, 'PHASE_4_PILGRIM_SELECTION', ctx.bookingCode);
      throw new VirtualQWorkflowError(
        'PILGRIM_SELECTION_FAILED',
        err.message || 'Failed during single saved pilgrim selection flow',
        'PHASE_4_PILGRIM_SELECTION',
        diag,
      );
    }
  }
}
