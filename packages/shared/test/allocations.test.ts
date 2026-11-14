import { describe, expect, it } from 'vitest';
import {
  allocationBalance,
  allocationInputSchema,
  allocationState,
  birdReturnInputSchema,
} from '../src/allocations.js';
import { saleInputSchema, stockMovementInputSchema } from '../src/poultry.js';

/**
 * A salesperson sells only from what the farm handed them, and the balance is
 * derived from events rather than stored.
 */

describe('allocation balance', () => {
  it('subtracts sales and returns from the allocated birds', () => {
    expect(
      allocationBalance({ allocated: 100, sold: [30, 20], returned: [5] }),
    ).toEqual({ allocated: 100, sold: 50, returned: 5, remaining: 45 });
  });

  it('is settled when nothing is left to sell', () => {
    const soldOut = allocationBalance({ allocated: 20, sold: [15], returned: [5] });
    expect(soldOut.remaining).toBe(0);
    expect(allocationState(soldOut)).toBe('settled');
    expect(allocationState(allocationBalance({ allocated: 20, sold: [], returned: [] }))).toBe(
      'open',
    );
  });
});

describe('allocation schemas', () => {
  const now = new Date().toISOString();

  it('accepts an allocation with a batch and a salesperson', () => {
    const parsed = allocationInputSchema.safeParse({
      batchId: '00000000-0000-4000-8000-000000000001',
      salespersonId: '00000000-0000-4000-8000-000000000002',
      count: 40,
      recordedAt: now,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an allocation of zero birds', () => {
    const parsed = allocationInputSchema.safeParse({
      batchId: '00000000-0000-4000-8000-000000000001',
      salespersonId: '00000000-0000-4000-8000-000000000002',
      count: 0,
      recordedAt: now,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a return of zero birds', () => {
    const parsed = birdReturnInputSchema.safeParse({
      allocationId: '00000000-0000-4000-8000-000000000001',
      count: 0,
      recordedAt: now,
    });
    expect(parsed.success).toBe(false);
  });

  it('carries an optional allocation on a sale', () => {
    const base = {
      batchId: '00000000-0000-4000-8000-000000000001',
      count: 5,
      recordedAt: now,
    };
    expect(saleInputSchema.safeParse(base).success).toBe(true);
    expect(
      saleInputSchema.safeParse({
        ...base,
        allocationId: '00000000-0000-4000-8000-000000000003',
      }).success,
    ).toBe(true);
  });

  it('lets a feed issue name the allocation it went out with', () => {
    const parsed = stockMovementInputSchema.safeParse({
      stockItemId: '00000000-0000-4000-8000-000000000001',
      kind: 'issue',
      quantityKg: 25,
      batchId: '00000000-0000-4000-8000-000000000002',
      allocationId: '00000000-0000-4000-8000-000000000003',
      recordedAt: now,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an allocation on a receipt or an adjustment', () => {
    const base = {
      stockItemId: '00000000-0000-4000-8000-000000000001',
      quantityKg: 25,
      batchId: '00000000-0000-4000-8000-000000000002',
      allocationId: '00000000-0000-4000-8000-000000000003',
      recordedAt: now,
    };
    expect(stockMovementInputSchema.safeParse({ ...base, kind: 'receipt' }).success).toBe(
      false,
    );
    expect(
      stockMovementInputSchema.safeParse({ ...base, kind: 'adjustment', quantityKg: -5 })
        .success,
    ).toBe(false);
  });
});
