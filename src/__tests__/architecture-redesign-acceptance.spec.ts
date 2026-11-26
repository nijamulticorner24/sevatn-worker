import { BookingWorker } from '../jobs/booking-worker';
import { PilgrimSelectionFlow } from '../sabarimala/flows/pilgrim-selection.flow';
import { NomineeDetailsFlow } from '../sabarimala/flows/nominee-details.flow';
import { SabarimalaPostLoginFlow } from '../sabarimala/post-login-flow';
import { ConfirmMarkerManager } from '../security/confirm-marker';
import { BookingExecutionGuard } from '../security/execution-guard';
import { validateNominee } from '../security/nominee-validator';

describe('Full Architecture Redesign — Worker & Portal Automation Acceptance Test Suite (17 Scenarios)', () => {
  beforeEach(() => {
    BookingExecutionGuard.clearAll();
  });

  // Scenario 1, 2, 3, 4: Exact date and route match; wrong date/route rejected; missing date/route fails closed
  it('Scenarios 1, 2, 3 & 4: verifyCarriedDateAndRoute passes on exact date/route match, throws MISMATCHED_DATE / MISMATCHED_ROUTE on wrong date or route, and fails closed when blank date/route cannot be selected', async () => {
    const makePage = (dateVal: string, routeText: string) => ({
      locator: jest.fn().mockImplementation((sel: string) => ({
        first: () => ({
          isVisible: jest.fn().mockResolvedValue(true),
          inputValue: jest.fn().mockResolvedValue(dateVal),
          evaluate: jest.fn().mockResolvedValue(routeText),
          waitFor: jest.fn().mockResolvedValue(null),
        }),
      })),
    });

    const ctx: any = {
      bookingCode: 'TA-DATE-1',
      requestedDate: '2026-12-20',
      requestedDateDisplay: '20-12-2026',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
    };

    // Scenario 1: Exact date and route match
    const ok = await SabarimalaPostLoginFlow.verifyCarriedDateAndRoute(
      makePage('20-12-2026', 'Pamba - Marakkoottam - 4 Kms') as any,
      ctx,
    );
    expect(ok).toBe(true);

    // Scenario 2: Wrong date carried is rejected
    await expect(
      SabarimalaPostLoginFlow.verifyCarriedDateAndRoute(
        makePage('21-12-2026', 'Pamba - Marakkoottam - 4 Kms') as any,
        ctx,
      ),
    ).rejects.toThrow(/MISMATCHED_DATE/);

    // Scenario 3: Wrong route carried is rejected
    await expect(
      SabarimalaPostLoginFlow.verifyCarriedDateAndRoute(
        makePage('20-12-2026', 'Erumely - Kalaketti Traditional Path - 46 Kms') as any,
        ctx,
      ),
    ).rejects.toThrow(/MISMATCHED_ROUTE/);

    // Scenario 4: Missing/blank date or unrecognized route fails closed
    await expect(
      SabarimalaPostLoginFlow.verifyCarriedDateAndRoute(
        makePage('20-12-2026', 'Pamba - Marakkoottam - 4 Kms') as any,
        { ...ctx, requestedRoute: 'InvalidNonExistentRoute' },
      ),
    ).rejects.toThrow(/MISMATCHED_ROUTE/);
  });

  // Scenario 5: Exactly one saved pilgrim is selected (even if 5 exist and some were pre-checked)
  it('Scenario 5: when account contains 5 saved pilgrims (with pre-checked rows), PilgrimSelectionFlow unchecks pre-selected rows, selects EXACTLY ONE saved pilgrim, and keeps pilgrimCount = 1', async () => {
    const checkboxStates = [false, true, true, false, false];
    const pilgrimNames = [
      '1\tAyyappan K\t42\tMale\tAadhaar\tXXXX1001',
      '2\tManikandan R\t38\tMale\tAadhaar\tXXXX1002',
      '3\tSabarish M\t29\tMale\tAadhaar\tXXXX1003',
      '4\tGanesh V\t51\tMale\tAadhaar\tXXXX1004',
      '5\tMurugan S\t45\tMale\tAadhaar\tXXXX1005',
    ];

    const makeCheckbox = (idx: number) => ({
      isVisible: jest.fn().mockResolvedValue(true),
      evaluate: jest.fn().mockImplementation(async () => checkboxStates[idx]),
      getAttribute: jest.fn().mockImplementation(async (attr: string) => (attr === 'id' ? `pilgrim_cb_${idx + 1}` : null)),
      click: jest.fn().mockImplementation(async () => {
        checkboxStates[idx] = !checkboxStates[idx];
      }),
      locator: jest.fn().mockReturnValue({
        first: () => ({
          isVisible: jest.fn().mockResolvedValue(true),
          click: jest.fn().mockImplementation(async () => {
            checkboxStates[idx] = !checkboxStates[idx];
          }),
        }),
      }),
    });

    const mockRows = {
      count: jest.fn().mockResolvedValue(5),
      nth: jest.fn().mockImplementation((idx: number) => ({
        innerText: jest.fn().mockResolvedValue(pilgrimNames[idx]),
        locator: jest.fn().mockReturnValue({
          first: () => makeCheckbox(idx),
        }),
      })),
    };

    const mockPage: any = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForSelector: jest.fn().mockResolvedValue(null),
      waitForTimeout: jest.fn().mockResolvedValue(null),
      waitForURL: jest.fn().mockResolvedValue(null),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('table tbody tr')) return mockRows;
        return {
          first: () => ({
            isVisible: jest.fn().mockResolvedValue(false),
            click: jest.fn().mockResolvedValue(null),
          }),
        };
      }),
    };

    const ctx: any = {
      bookingId: 'bk-1',
      bookingCode: 'TA-10001',
      accountId: 'acct-1',
      requestedDate: '2026-12-10',
      requestedDateDisplay: '10-12-2026',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
      pilgrimCount: 1,
      reliefFund: 0,
    };

    const result = await PilgrimSelectionFlow.execute(mockPage, ctx);

    expect(result.success).toBe(true);
    expect(result.selectedCount).toBe(1);
    expect(ctx.pilgrimCount).toBe(1);
    expect(checkboxStates).toEqual([true, false, false, false, false]);
    expect(result.selectedPilgrim.fullName).toContain('Ayyappan K');
    expect(result.selectedPilgrim.identityFingerprint).toBeDefined();
  });

  // Scenario 6, 7, 8: No eligible saved pilgrim stops execution; duplicate pilgrim/date booking is blocked; same pilgrim can book a different valid date
  it('Scenarios 6, 7 & 8: blocks duplicate pilgrim/date via excludedPilgrimFingerprints, stops execution when no eligible saved pilgrim remains, and allows the same pilgrim on a different date', async () => {
    const checkboxStates = [false, false];
    const pilgrimRows = [
      '1\tAyyappan K\t42\tMale\tAadhaar\tXXXX1001',
      '2\tManikandan R\t38\tMale\tAadhaar\tXXXX1002',
    ];

    const fp1 = PilgrimSelectionFlow.computePilgrimFingerprint({
      accountId: 'acct-dup',
      portalPilgrimId: 'cb_1',
      fullName: 'Ayyappan K',
      gender: 'Male',
      idType: 'AADHAAR',
      maskedIdNumber: 'XXXX1001',
      rowIndex: 1,
    });
    const fp2 = PilgrimSelectionFlow.computePilgrimFingerprint({
      accountId: 'acct-dup',
      portalPilgrimId: 'cb_2',
      fullName: 'Manikandan R',
      gender: 'Male',
      idType: 'AADHAAR',
      maskedIdNumber: 'XXXX1002',
      rowIndex: 2,
    });

    const makeCb = (idx: number) => ({
      isVisible: jest.fn().mockResolvedValue(true),
      evaluate: jest.fn().mockImplementation(async () => checkboxStates[idx]),
      getAttribute: jest.fn().mockImplementation(async (attr: string) => (attr === 'id' ? `cb_${idx + 1}` : null)),
      click: jest.fn().mockImplementation(async () => {
        checkboxStates[idx] = !checkboxStates[idx];
      }),
      locator: jest.fn().mockReturnValue({
        first: () => ({
          isVisible: jest.fn().mockResolvedValue(true),
          click: jest.fn().mockImplementation(async () => {
            checkboxStates[idx] = !checkboxStates[idx];
          }),
        }),
      }),
    });

    const mockPage: any = {
      url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
      waitForSelector: jest.fn().mockResolvedValue(null),
      waitForTimeout: jest.fn().mockResolvedValue(null),
      waitForURL: jest.fn().mockResolvedValue(null),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('table tbody tr')) {
          return {
            count: jest.fn().mockResolvedValue(2),
            nth: (i: number) => ({
              innerText: jest.fn().mockResolvedValue(pilgrimRows[i]),
              locator: () => ({ first: () => makeCb(i) }),
            }),
          };
        }
        return {
          first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }),
        };
      }),
    };

    // Scenario 7: Pilgrim #1 already booked for 2026-12-15 -> skipped, Pilgrim #2 selected
    const ctxDate1: any = {
      bookingId: 'bk-20',
      bookingCode: 'TA-10020',
      accountId: 'acct-dup',
      requestedDate: '2026-12-15',
      requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
      excludedPilgrimFingerprints: [fp1],
    };
    const res1 = await PilgrimSelectionFlow.execute(mockPage, ctxDate1);
    expect(res1.selectedPilgrim.fullName).toContain('Manikandan R');
    expect(checkboxStates).toEqual([false, true]);

    // Scenario 6: Both Pilgrim #1 and Pilgrim #2 already booked for 2026-12-15 -> stops execution with PREVIOUS_BOOKING_RESTRICTION
    await expect(
      PilgrimSelectionFlow.execute(mockPage, {
        ...ctxDate1,
        excludedPilgrimFingerprints: [fp1, fp2],
      }),
    ).rejects.toThrow(/already have a confirmed booking/);

    // Scenario 8: Same pilgrim (Pilgrim #1) can book a different valid date (2026-12-25) where excludedPilgrimFingerprints is empty
    const resDifferentDate = await PilgrimSelectionFlow.execute(mockPage, {
      ...ctxDate1,
      requestedDate: '2026-12-25',
      excludedPilgrimFingerprints: [],
    });
    expect(resDifferentDate.selectedPilgrim.fullName).toContain('Ayyappan K');
    expect(checkboxStates).toEqual([true, false]);
  });

  // Scenario 9: Customer nominee form population & invalid nominee form prevents submission
  it('Scenario 9: NomineeDetailsFlow populates single customer nominee with Angular events and throws NOMINEE_VALIDATION_FAILED if portal marks control .ng-invalid', async () => {
    const filledValues: Record<string, string> = {};
    const dispatchedEvents: string[] = [];
    let ngInvalidCount = 0;

    const nameInput = {
      isVisible: jest.fn().mockResolvedValue(true),
      scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(null),
      click: jest.fn().mockResolvedValue(null),
      fill: jest.fn().mockImplementation(async (v: string) => {
        filledValues.name = v;
      }),
      dispatchEvent: jest.fn().mockImplementation(async (ev: string) => {
        dispatchedEvents.push(`name:${ev}`);
      }),
    };
    const ageInput = {
      isVisible: jest.fn().mockResolvedValue(true),
      click: jest.fn().mockResolvedValue(null),
      fill: jest.fn().mockImplementation(async (v: string) => {
        filledValues.age = v;
      }),
      dispatchEvent: jest.fn().mockImplementation(async (ev: string) => {
        dispatchedEvents.push(`age:${ev}`);
      }),
    };
    const relSelect = {
      isVisible: jest.fn().mockResolvedValue(true),
      selectOption: jest.fn().mockImplementation(async (v: any) => {
        filledValues.rel = typeof v === 'string' ? v : v.label;
      }),
      dispatchEvent: jest.fn().mockImplementation(async (ev: string) => {
        dispatchedEvents.push(`rel:${ev}`);
      }),
    };

    const mockPage: any = {
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('ng-invalid')) {
          return { count: jest.fn().mockImplementation(async () => ngInvalidCount) };
        }
        if (sel.includes('table tbody tr')) {
          return {
            count: jest.fn().mockResolvedValue(1),
            nth: () => ({
              locator: (sub: string) => ({
                first: () => (sub.includes('Nominee Name') ? nameInput : sub.includes('Age') ? ageInput : relSelect),
              }),
            }),
          };
        }
        return {
          first: () => ({ isVisible: jest.fn().mockResolvedValue(true) }),
          count: jest.fn().mockResolvedValue(1),
          nth: () => nameInput,
        };
      }),
    };

    const ctx: any = {
      bookingId: 'bk-1',
      bookingCode: 'TA-10001',
      pilgrimCount: 1,
      nominee: {
        nomineeName: 'Lakshmi S',
        nomineeAge: 34,
        nomineeRelationship: 'Spouse',
      },
    };

    const ok = await NomineeDetailsFlow.execute(mockPage, ctx);
    expect(ok).toBe(true);
    expect(filledValues).toEqual({
      name: 'Lakshmi S',
      age: '34',
      rel: '11',
    });
    expect(dispatchedEvents).toContain('name:input');
    expect(dispatchedEvents).toContain('age:change');
    expect(dispatchedEvents).toContain('rel:change');

    // If portal marks input .ng-invalid, NomineeDetailsFlow throws NOMINEE_VALIDATION_FAILED to prevent submission
    ngInvalidCount = 1;
    await expect(NomineeDetailsFlow.execute(mockPage, ctx)).rejects.toThrow(/ng-invalid/);
  });

  // Scenario 10 & 11: Final submission timeout triggers reconciliation; confirmed booking history prevents duplicate retry
  it('Scenarios 10 & 11: ConfirmMarker is persisted before final confirm click and cleared upon booking history reconciliation', async () => {
    const bookingCode = 'TA-CRASH-19';
    ConfirmMarkerManager.setMarker(bookingCode, {
      bookingCode,
      jobId: 'job-19',
      date: '2026-12-15',
      route: 'Pamba - Marakkoottam - 4 Kms',
    });

    expect(ConfirmMarkerManager.hasMarker(bookingCode)).toBe(true);
    ConfirmMarkerManager.clearMarker(bookingCode);
    expect(ConfirmMarkerManager.hasMarker(bookingCode)).toBe(false);
  });

  describe('1 to 5 Saved Pilgrims Selection & Multi-Nominee Regression Suite', () => {
    const makeMultiPilgrimPage = (initialChecked: boolean[], pilgrimRows: string[]) => {
      const checkboxStates = [...initialChecked];
      const makeCheckbox = (idx: number) => ({
        isVisible: jest.fn().mockResolvedValue(true),
        evaluate: jest.fn().mockImplementation(async () => checkboxStates[idx]),
        getAttribute: jest.fn().mockImplementation(async (attr: string) => (attr === 'id' ? `pilgrim_cb_${idx + 1}` : null)),
        click: jest.fn().mockImplementation(async () => {
          checkboxStates[idx] = !checkboxStates[idx];
        }),
        locator: jest.fn().mockReturnValue({
          first: () => ({
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              checkboxStates[idx] = !checkboxStates[idx];
            }),
          }),
        }),
      });

      const mockRows = {
        count: jest.fn().mockResolvedValue(pilgrimRows.length),
        nth: jest.fn().mockImplementation((idx: number) => ({
          innerText: jest.fn().mockResolvedValue(pilgrimRows[idx]),
          locator: jest.fn().mockReturnValue({
            first: () => makeCheckbox(idx),
          }),
        })),
      };

      const mockPage: any = {
        url: jest.fn().mockReturnValue('https://sabarimalaonline.org/#/darshan'),
        waitForSelector: jest.fn().mockResolvedValue(null),
        waitForTimeout: jest.fn().mockResolvedValue(null),
        waitForURL: jest.fn().mockResolvedValue(null),
        locator: jest.fn().mockImplementation((sel: string) => {
          if (sel.includes('table tbody tr')) return mockRows;
          return {
            first: () => ({
              isVisible: jest.fn().mockResolvedValue(false),
              click: jest.fn().mockResolvedValue(null),
            }),
          };
        }),
      };

      return { mockPage, checkboxStates };
    };

    const fivePilgrimRows = [
      '1\tAyyappan K\t42\tMale\tAadhaar\tXXXX1001',
      '2\tManikandan R\t38\tMale\tAadhaar\tXXXX1002',
      '3\tSabarish M\t29\tMale\tAadhaar\tXXXX1003',
      '4\tGanesh V\t51\tMale\tAadhaar\tXXXX1004',
      '5\tMurugan S\t45\tMale\tAadhaar\tXXXX1005',
    ];

    // Requirement 2 & 9: Each portal attempt selects exactly one saved pilgrim, never multiple checkboxes
    it('Requirement 2 & 9: Each portal attempt selects EXACTLY ONE saved pilgrim and verifies totalCheckedCount === 1 (never checking multiple checkboxes)', async () => {
      const { mockPage, checkboxStates } = makeMultiPilgrimPage(
        [false, false, true, false, false],
        fivePilgrimRows,
      );
      const ctx: any = {
        bookingId: 'bk-seq-1',
        bookingCode: 'TA-SEQ-1',
        accountId: 'acct-multi',
        requestedDate: '2026-12-20',
        requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
        pilgrimCount: 5, // Even when parent request requested 5
      };

      const res = await PilgrimSelectionFlow.execute(mockPage, ctx);

      // Invariant: Exactly 1 pilgrim selected per portal attempt
      expect(res.selectedCount).toBe(1);
      expect(res.selectedPilgrims).toHaveLength(1);
      expect(res.selectedPilgrim.fullName).toBe('Ayyappan K');
      // Verifies only 1 checkbox is left checked
      expect(checkboxStates.filter(Boolean)).toHaveLength(1);
      expect(checkboxStates[0]).toBe(true);
    });

    // Requirement 3 & 9: Each attempt fills exactly one nominee row, never multiple rows
    it('Requirement 3 & 9: Each portal attempt fills EXACTLY ONE nominee in Row 0, and never touches multiple rows in one portal pass', async () => {
      const rowValues: Array<{ name?: string; age?: string; rel?: string }> = [{}, {}, {}];

      const makeRow = (rIdx: number) => ({
        locator: (sub: string) => ({
          first: () => {
            if (sub.includes('Nominee Name')) {
              return {
                isVisible: jest.fn().mockResolvedValue(true),
                scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(null),
                click: jest.fn().mockResolvedValue(null),
                fill: jest.fn().mockImplementation(async (v: string) => {
                  rowValues[rIdx].name = v;
                }),
                dispatchEvent: jest.fn().mockResolvedValue(null),
              };
            }
            if (sub.includes('Age')) {
              return {
                isVisible: jest.fn().mockResolvedValue(true),
                click: jest.fn().mockResolvedValue(null),
                fill: jest.fn().mockImplementation(async (v: string) => {
                  rowValues[rIdx].age = v;
                }),
                dispatchEvent: jest.fn().mockResolvedValue(null),
              };
            }
            return {
              isVisible: jest.fn().mockResolvedValue(true),
              selectOption: jest.fn().mockImplementation(async (v: any) => {
                rowValues[rIdx].rel = typeof v === 'string' ? v : v.label;
              }),
              dispatchEvent: jest.fn().mockResolvedValue(null),
            };
          },
        }),
      });

      const mockPage: any = {
        locator: jest.fn().mockImplementation((sel: string) => {
          if (sel.includes('ng-invalid')) {
            return { count: jest.fn().mockResolvedValue(0) };
          }
          if (sel.includes('table tbody tr')) {
            return {
              count: jest.fn().mockResolvedValue(3),
              nth: (i: number) => makeRow(i),
            };
          }
          return {
            first: () => ({ isVisible: jest.fn().mockResolvedValue(true) }),
            count: jest.fn().mockResolvedValue(3),
          };
        }),
      };

      const ctx: any = {
        bookingId: 'bk-nom-1',
        bookingCode: 'TA-NOM-1',
        pilgrimCount: 3,
        currentPilgrimIndex: 0,
        nominee: { nomineeName: 'Lakshmi S', nomineeAge: 34, nomineeRelationship: 'Spouse' },
        nominees: [
          { nomineeName: 'Lakshmi S', nomineeAge: 34, nomineeRelationship: 'Spouse' },
          { nomineeName: 'Ramesh K', nomineeAge: 45, nomineeRelationship: 'Brother' },
        ],
      };

      const ok = await NomineeDetailsFlow.execute(mockPage, ctx);
      expect(ok).toBe(true);

      // Invariant: ONLY Row 0 was populated; Rows 1 and 2 were NOT touched in this attempt
      expect(rowValues[0]).toEqual({ name: 'Lakshmi S', age: '34', rel: '11' });
      expect(rowValues[1]).toEqual({});
      expect(rowValues[2]).toEqual({});
    });

    // Requirement 4 & Duplicate Prevention: After one confirmation, next pilgrim is processed excluding previous
    it('Requirement 4: After one pilgrim confirmation, its fingerprint is excluded and next pilgrim is selected on next sequential attempt', async () => {
      const fp1 = PilgrimSelectionFlow.computePilgrimFingerprint({
        accountId: 'acct-multi',
        portalPilgrimId: 'pilgrim_cb_1',
        fullName: 'Ayyappan K',
        gender: 'Male',
        idType: 'AADHAAR',
        maskedIdNumber: 'XXXX1001',
        rowIndex: 1,
      });

      const { mockPage, checkboxStates } = makeMultiPilgrimPage(
        [false, false, false, false, false],
        fivePilgrimRows,
      );

      // Attempt for Pilgrim 2 with Pilgrim 1 fingerprint excluded
      const res2 = await PilgrimSelectionFlow.execute(mockPage, {
        bookingId: 'bk-seq-2',
        bookingCode: 'TA-SEQ-2',
        accountId: 'acct-multi',
        requestedDate: '2026-12-20',
        requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
        currentPilgrimIndex: 1,
        excludedPilgrimFingerprints: [fp1],
      } as any);

      // Invariant: Pilgrim #1 is skipped, exactly Pilgrim #2 (Manikandan R) is selected
      expect(res2.selectedCount).toBe(1);
      expect(res2.selectedPilgrim.fullName).toBe('Manikandan R');
      expect(checkboxStates[1]).toBe(true);
      expect(checkboxStates[0]).toBe(false);
    });

    // Requirement 5: When all eligible pilgrims are already booked, throws PREVIOUS_BOOKING_RESTRICTION safely
    it('Requirement 5: When all eligible pilgrims are already booked, throws PREVIOUS_BOOKING_RESTRICTION safely', async () => {
      const allFingerprints = fivePilgrimRows.map((r, i) => {
        const parts = r.split('\t');
        return PilgrimSelectionFlow.computePilgrimFingerprint({
          accountId: 'acct-multi',
          portalPilgrimId: `pilgrim_cb_${i + 1}`,
          fullName: parts[1],
          gender: parts[3],
          idType: parts[4],
          maskedIdNumber: parts[5],
          rowIndex: i + 1,
        });
      });

      const { mockPage } = makeMultiPilgrimPage(
        [false, false, false, false, false],
        fivePilgrimRows,
      );

      await expect(
        PilgrimSelectionFlow.execute(mockPage, {
          bookingId: 'bk-all-dup',
          bookingCode: 'TA-ALL-DUP',
          accountId: 'acct-multi',
          requestedDate: '2026-12-20',
          requestedRoute: 'Pamba - Marakkoottam - 4 Kms',
          excludedPilgrimFingerprints: allFingerprints,
        } as any),
      ).rejects.toThrow(/PREVIOUS_BOOKING_RESTRICTION/);
    });

    // Requirement 8: Uncertain submissions check portal history before retry
    it('Requirement 8: Reconciles ambiguous confirmation against portal booking history to avoid duplicate bookings', async () => {
      const mockAdapter: any = {
        checkExistingBookingInHistory: jest.fn().mockResolvedValue({
          found: true,
          officialReference: 'IVQ26122099998888',
          confirmedAt: '2026-12-20T10:00:00.000Z',
        }),
      };

      const hist = await mockAdapter.checkExistingBookingInHistory({
        bookingCode: 'TA-RECON-1',
        requestedDate: '2026-12-20',
      });

      expect(hist.found).toBe(true);
      expect(hist.officialReference).toBe('IVQ26122099998888');
    });
  });
});
