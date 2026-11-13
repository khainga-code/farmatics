import { describe, expect, it } from 'vitest';
import {
  batchFinance,
  expenseApprovalInputSchema,
  expenseInputSchema,
  expenseState,
  expensesByCategory,
  roundKes,
  saleRevenueKes,
  sumKes,
  type ExpenseLike,
} from '../src/finance.js';

/**
 * Finance is a cash book: every total is derived from immutable events, and an
 * unpriced sale is reported as missing rather than counted as zero.
 */

describe('money arithmetic', () => {
  it('rounds to the nearest cent instead of carrying float dust', () => {
    expect(roundKes(0.1 + 0.2)).toBe(0.3);
    expect(roundKes(12.3456)).toBe(12.35);
    expect(sumKes([10.005, 20.005])).toBe(30.01);
  });
});

describe('sale revenue', () => {
  it('multiplies birds by price per bird', () => {
    expect(saleRevenueKes({ count: 120, unitPriceKes: 350 })).toBe(42000);
    expect(saleRevenueKes({ count: 3, unitPriceKes: 33.333 })).toBe(100);
  });

  it('keeps an unpriced sale out of revenue rather than calling it zero', () => {
    expect(saleRevenueKes({ count: 10 })).toBeNull();
    expect(saleRevenueKes({ count: 10, unitPriceKes: null })).toBeNull();
  });
});

describe('expenses', () => {
  const expenses: ExpenseLike[] = [
    { id: 'a', category: 'feed', amountKes: 1200 },
    { id: 'b', category: 'labour', amountKes: 800.5 },
    { id: 'c', category: 'feed', amountKes: 300 },
  ];

  it('groups by category in a stable order', () => {
    expect(expensesByCategory(expenses)).toEqual([
      { category: 'feed', totalKes: 1500 },
      { category: 'labour', totalKes: 800.5 },
    ]);
  });

  it('derives approval state from append-only decisions', () => {
    const approvals = [
      { expenseId: 'a', decision: 'approved' as const },
      { expenseId: 'b', decision: 'rejected' as const },
    ];
    expect(expenseState('a', approvals)).toBe('approved');
    expect(expenseState('b', approvals)).toBe('rejected');
    expect(expenseState('c', approvals)).toBe('pending');
  });

  it('requires a positive amount and defaults the method to cash', () => {
    const base = {
      category: 'feed',
      recordedAt: '2026-02-01T09:00:00.000Z',
    };
    const parsed = expenseInputSchema.safeParse({ ...base, amountKes: 1500 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.method).toBe('cash');

    expect(expenseInputSchema.safeParse({ ...base, amountKes: 0 }).success).toBe(false);
    expect(expenseInputSchema.safeParse({ ...base, amountKes: -5 }).success).toBe(false);
  });

  it('accepts only an approval or a rejection', () => {
    const base = {
      expenseId: '11111111-1111-4111-8111-111111111111',
      recordedAt: '2026-02-01T09:00:00.000Z',
    };
    expect(expenseApprovalInputSchema.safeParse({ ...base, decision: 'approved' }).success).toBe(
      true,
    );
    expect(expenseApprovalInputSchema.safeParse({ ...base, decision: 'maybe' }).success).toBe(
      false,
    );
  });
});

describe('batch margin', () => {
  const sale = (id: string, price: number | undefined) => ({
    batchId: 'batch-1',
    count: 100,
    unitPriceKes: price,
    id,
  });

  it('counts revenue and approved direct costs only', () => {
    const result = batchFinance(
      'batch-1',
      [sale('s1', 350), sale('s2', 300)],
      [
        { id: 'e1', category: 'transport', amountKes: 2000, batchId: 'batch-1' },
        { id: 'e2', category: 'labour', amountKes: 5000, batchId: 'batch-1' },
        { id: 'e3', category: 'feed', amountKes: 9000, batchId: 'batch-1' },
        { id: 'other', category: 'utilities', amountKes: 1000, batchId: 'batch-2' },
      ],
      [
        { expenseId: 'e1', decision: 'approved' },
        { expenseId: 'e2', decision: 'rejected' },
      ],
    );

    expect(result.revenueKes).toBe(65000);
    expect(result.expensesKes).toBe(2000);
    expect(result.marginKes).toBe(63000);
    expect(result.unpricedSales).toBe(0);
  });

  it('warns when some sales have no price', () => {
    const result = batchFinance('batch-1', [sale('s1', 350), sale('s2', undefined)], [], []);
    expect(result.revenueKes).toBe(35000);
    expect(result.unpricedSales).toBe(1);
  });
});
