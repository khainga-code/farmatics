import { describe, expect, it } from 'vitest';
import {
  canSeeFinance,
  dayMoney,
  monthMoney,
  pendingExpenseCount,
  rangeMoney,
} from '../src/money.js';

/**
 * One set of money selectors for Home and Finance. Both screens used to do
 * this arithmetic themselves, which is how two views of the same cash book
 * drift apart.
 */

const sales = [
  { recordedAt: '2026-05-01T08:00:00.000Z', count: 10, unitPriceKes: 500 },
  { recordedAt: '2026-05-01T15:00:00.000Z', count: 5, unitPriceKes: 600 },
  { recordedAt: '2026-05-02T09:00:00.000Z', count: 4, unitPriceKes: null },
  { recordedAt: '2026-04-30T09:00:00.000Z', count: 2, unitPriceKes: 450 },
];

const expenses = [
  { id: 'a', amountKes: 1200, recordedAt: '2026-05-01T10:00:00.000Z' },
  { id: 'b', amountKes: 800, recordedAt: '2026-05-02T10:00:00.000Z' },
  { id: 'c', amountKes: 300, recordedAt: '2026-04-29T10:00:00.000Z' },
];

const approvals = [
  { expenseId: 'a', decision: 'approved' as const },
  { expenseId: 'b', decision: 'rejected' as const },
  { expenseId: 'c', decision: 'approved' as const },
];

describe('month money', () => {
  it('counts priced sales in and only approved expenses out', () => {
    const money = monthMoney(sales, expenses, approvals, '2026-05-14');
    expect(money.revenueKes).toBe(8000);
    expect(money.spendKes).toBe(1200);
    expect(money.netKes).toBe(6800);
  });

  it('reports unpriced sales instead of counting them as zero', () => {
    const money = monthMoney(sales, expenses, approvals, '2026-05-14');
    expect(money.unpricedSales).toBe(1);
    // The unpriced sale's four birds add nothing to revenue by design.
    expect(money.revenueKes).toBe(10 * 500 + 5 * 600);
  });

  it('leaves out another month entirely', () => {
    const money = monthMoney(sales, expenses, approvals, '2026-04-14');
    expect(money.revenueKes).toBe(900);
    expect(money.spendKes).toBe(300);
    expect(money.unpricedSales).toBe(0);
  });
});

describe('day money', () => {
  it('splits the month down to one day', () => {
    const money = dayMoney(sales, expenses, approvals, '2026-05-01');
    expect(money.revenueKes).toBe(10 * 500 + 5 * 600);
    expect(money.spendKes).toBe(1200);
    expect(money.netKes).toBe(6800);
  });

  it('returns zeros on a day with nothing', () => {
    expect(dayMoney(sales, expenses, approvals, '2026-05-09')).toMatchObject({
      revenueKes: 0,
      spendKes: 0,
      netKes: 0,
    });
  });
});

describe('range money', () => {
  it('includes both ends of the range and leaves the rest out', () => {
    const money = rangeMoney(sales, expenses, approvals, '2026-05-01', '2026-05-02');
    expect(money.revenueKes).toBe(10 * 500 + 5 * 600);
    expect(money.spendKes).toBe(1200);
    expect(money.netKes).toBe(6800);
    expect(money.unpricedSales).toBe(1);
  });

  it('agrees with the day and month selectors on the same edges', () => {
    expect(rangeMoney(sales, expenses, approvals, '2026-05-01', '2026-05-01')).toEqual(
      dayMoney(sales, expenses, approvals, '2026-05-01'),
    );
    expect(rangeMoney(sales, expenses, approvals, '2026-05-01', '2026-05-31')).toEqual(
      monthMoney(sales, expenses, approvals, '2026-05-14'),
    );
  });

  it('returns zeros for a range with nothing in it', () => {
    expect(rangeMoney(sales, expenses, approvals, '2026-03-01', '2026-03-31')).toMatchObject({
      revenueKes: 0,
      spendKes: 0,
      netKes: 0,
      unpricedSales: 0,
    });
  });
});

describe('pending expenses', () => {
  it('counts only expenses with no decision yet', () => {
    const undecided = [
      ...expenses,
      { id: 'd', amountKes: 50, recordedAt: '2026-05-03T10:00:00.000Z' },
    ];
    expect(pendingExpenseCount(undecided, approvals)).toBe(1);
  });
});

describe('finance route permission', () => {
  it('opens for a viewer or a recorder, and for nobody else', () => {
    expect(canSeeFinance(['view_finance'])).toBe(true);
    expect(canSeeFinance(['record_expense'])).toBe(true);
    expect(canSeeFinance(['view_reports', 'record_sale'])).toBe(false);
    expect(canSeeFinance([])).toBe(false);
  });
});
