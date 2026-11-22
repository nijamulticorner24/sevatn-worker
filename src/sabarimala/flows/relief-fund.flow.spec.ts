import { ReliefFundFlow } from './relief-fund.flow';
import { BookingExecutionContext, VirtualQWorkflowError } from './types';

describe('ReliefFundFlow & Clean Sabarimala Fail-Safe', () => {
  function createMockLocator(overrides: Record<string, any> = {}) {
    const loc: any = {
      isVisible: jest.fn().mockResolvedValue(true),
      scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
      check: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(false),
      inputValue: jest.fn().mockResolvedValue(''),
      innerText: jest.fn().mockResolvedValue(''),
      count: jest.fn().mockResolvedValue(1),
      first: () => loc,
      nth: () => loc,
      ...overrides,
    };
    return loc;
  }

  it('Clean Sabarimala defaulting to Yes with ₹25: clicks No and verifies amount resets to ₹0', async () => {
    let cleanNoChecked = false;
    let cleanYesChecked = true;
    let totalAmount = 25;

    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        // Pilgrim relief fund: No is already checked
        if (sel.includes('name="contribute"]') || sel.includes('Pilgrim Relief')) {
          if (sel.includes('value="no"') || sel.includes('No')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              evaluate: jest.fn().mockResolvedValue(true),
            });
          }
          if (sel.includes('value="yes"') || sel.includes('Yes')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              evaluate: jest.fn().mockResolvedValue(false),
            });
          }
          return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false) });
        }

        // Relief amount selectors
        if (sel.includes('relief-amount') || sel.includes('fund-amount')) {
          return createMockLocator({
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('₹0'),
          });
        }

        // Clean Sabarimala selectors
        if (sel.includes('clean')) {
          if (sel.includes('No') || sel.includes('no')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              click: jest.fn().mockImplementation(async () => {
                cleanNoChecked = true;
                cleanYesChecked = false;
                totalAmount = 0;
              }),
              evaluate: jest.fn().mockImplementation(async () => cleanNoChecked),
            });
          }
          if (sel.includes('Yes') || sel.includes('yes')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              evaluate: jest.fn().mockImplementation(async () => cleanYesChecked),
            });
          }
          if (sel.includes('.clean-amount') || sel.includes('amount')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              innerText: jest.fn().mockImplementation(async () => (totalAmount > 0 ? `₹${totalAmount}` : '₹0')),
            });
          }
        }

        // Total amount selectors
        if (sel.includes('total-amount') || sel.includes('total')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockImplementation(async () => (totalAmount > 0 ? `Total: ₹${totalAmount}` : 'Total: ₹0')),
            inputValue: jest.fn().mockImplementation(async () => (totalAmount > 0 ? `${totalAmount}` : '0')),
          });
        }

        return createMockLocator({
          isVisible: jest.fn().mockResolvedValue(false),
          count: jest.fn().mockResolvedValue(0),
        });
      }),
      getByLabel: jest.fn().mockImplementation(() =>
        createMockLocator({
          isVisible: jest.fn().mockResolvedValue(true),
          evaluate: jest.fn().mockResolvedValue(true),
        })
      ),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-clean-1',
      bookingCode: 'TA-CLEAN-01',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      reliefFund: 25,
    };

    const success = await ReliefFundFlow.execute(mockPage, ctx);
    expect(success).toBe(true);
    expect(cleanNoChecked).toBe(true);
    expect(cleanYesChecked).toBe(false);
    expect(ctx.reliefFund).toBe(0);
    expect(ctx.reliefFundSelection).toBe('NO');
  });

  it('Both Pilgrim Relief and Clean Sabarimala default to Yes: clicks No on both and verifies ₹0', async () => {
    let reliefNoChecked = false;
    let cleanNoChecked = false;
    let reliefYesChecked = true;
    let cleanYesChecked = true;
    let totalAmount = 50;

    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('name="contribute"]') || sel.includes('relief')) {
          if (sel.includes('No') || sel.includes('no')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              click: jest.fn().mockImplementation(async () => {
                reliefNoChecked = true;
                reliefYesChecked = false;
                totalAmount -= 25;
              }),
              evaluate: jest.fn().mockImplementation(async () => reliefNoChecked),
            });
          }
          if (sel.includes('Yes') || sel.includes('yes')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              evaluate: jest.fn().mockImplementation(async () => reliefYesChecked),
            });
          }
        }

        if (sel.includes('clean')) {
          if (sel.includes('No') || sel.includes('no')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              click: jest.fn().mockImplementation(async () => {
                cleanNoChecked = true;
                cleanYesChecked = false;
                totalAmount -= 25;
              }),
              evaluate: jest.fn().mockImplementation(async () => cleanNoChecked),
            });
          }
          if (sel.includes('Yes') || sel.includes('yes')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              evaluate: jest.fn().mockImplementation(async () => cleanYesChecked),
            });
          }
        }

        if (sel.includes('total-amount') || sel.includes('total')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockImplementation(async () => `₹${totalAmount}`),
            inputValue: jest.fn().mockImplementation(async () => `${totalAmount}`),
          });
        }

        return createMockLocator({
          isVisible: jest.fn().mockResolvedValue(false),
          count: jest.fn().mockResolvedValue(0),
        });
      }),
      getByLabel: jest.fn().mockImplementation(() =>
        createMockLocator({
          isVisible: jest.fn().mockResolvedValue(true),
          evaluate: jest.fn().mockResolvedValue(true),
        })
      ),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-both-1',
      bookingCode: 'TA-BOTH-01',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      reliefFund: 50,
    };

    const success = await ReliefFundFlow.execute(mockPage, ctx);
    expect(success).toBe(true);
    expect(reliefNoChecked).toBe(true);
    expect(cleanNoChecked).toBe(true);
    expect(ctx.reliefFund).toBe(0);
  });

  it('Fail-safe auto-recovers when unexpected donation > 0 has unchecked No buttons', async () => {
    let failSafeClicked = false;
    let totalAmount = 100;

    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        // Normal Pilgrim Relief flow succeeds
        if (sel.includes('name="contribute"]') || sel.includes('relief')) {
          if (sel.includes('No') || sel.includes('no')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              evaluate: jest.fn().mockResolvedValue(true),
            });
          }
          if (sel.includes('Yes') || sel.includes('yes')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(false),
              evaluate: jest.fn().mockResolvedValue(false),
            });
          }
        }

        // Clean Sabarimala is not rendered on this page
        if (sel.includes('clean')) {
          return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
        }

        // Fail-safe candidates: unchecked No radio buttons
        if (sel.includes(':not') && sel.includes('No')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            isVisible: jest.fn().mockResolvedValue(true),
            click: jest.fn().mockImplementation(async () => {
              failSafeClicked = true;
              totalAmount = 0; // successfully neutralized
            }),
          });
        }

        // Total amount
        if (sel.includes('total-amount') || sel.includes('total')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockImplementation(async () => `₹${totalAmount}`),
            inputValue: jest.fn().mockImplementation(async () => `${totalAmount}`),
          });
        }

        return createMockLocator({
          isVisible: jest.fn().mockResolvedValue(false),
          count: jest.fn().mockResolvedValue(0),
        });
      }),
      getByLabel: jest.fn().mockImplementation(() =>
        createMockLocator({
          isVisible: jest.fn().mockResolvedValue(true),
          evaluate: jest.fn().mockResolvedValue(true),
        })
      ),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-fs-1',
      bookingCode: 'TA-FS-01',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      reliefFund: 100,
    };

    const success = await ReliefFundFlow.execute(mockPage, ctx);
    expect(success).toBe(true);
    expect(failSafeClicked).toBe(true);
    expect(ctx.reliefFund).toBe(0);
  });

  it('Fail-safe aborts booking with VirtualQWorkflowError if total amount is STILL > 0', async () => {
    const totalAmount = 50; // remains 50 even after clicking

    const mockPage: any = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockImplementation((sel: string) => {
        if (sel.includes('name="contribute"]') || sel.includes('relief')) {
          if (sel.includes('No') || sel.includes('no')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(true),
              evaluate: jest.fn().mockResolvedValue(true),
            });
          }
          if (sel.includes('Yes') || sel.includes('yes')) {
            return createMockLocator({
              isVisible: jest.fn().mockResolvedValue(false),
              evaluate: jest.fn().mockResolvedValue(false),
            });
          }
        }

        if (sel.includes('clean')) {
          return createMockLocator({ isVisible: jest.fn().mockResolvedValue(false), count: jest.fn().mockResolvedValue(0) });
        }

        // Total amount stays 50
        if (sel.includes('total-amount') || sel.includes('total')) {
          return createMockLocator({
            count: jest.fn().mockResolvedValue(1),
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('₹50'),
            inputValue: jest.fn().mockResolvedValue('50'),
          });
        }

        return createMockLocator({
          isVisible: jest.fn().mockResolvedValue(false),
          count: jest.fn().mockResolvedValue(0),
        });
      }),
      getByLabel: jest.fn().mockImplementation(() =>
        createMockLocator({
          isVisible: jest.fn().mockResolvedValue(true),
          evaluate: jest.fn().mockResolvedValue(true),
        })
      ),
    };

    const ctx: BookingExecutionContext = {
      bookingId: 'b-fs-fail',
      bookingCode: 'TA-FS-FAIL',
      requestedDate: '2026-11-24',
      requestedDateDisplay: '24-11-2026',
      requestedRoute: 'Pamba',
      reliefFund: 50,
    };

    await expect(ReliefFundFlow.execute(mockPage, ctx)).rejects.toThrow(
      /Unwanted donation detected\. Total amount is > 0 \(₹50\)/
    );
  });
});
