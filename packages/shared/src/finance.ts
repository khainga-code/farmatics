/**
 * Finance: what came in, what went out, and what a batch actually earned.
 *
 * The farm chose cash only, so there are no invoices or receivables here. A
 * sale carries the price it was sold at, an expense carries the amount that was
 * paid, and every total is derived from those events. Nothing stores a running
 * balance.
 *
 * Amounts are Kenyan shillings rounded to two decimal places once, at the point
 * they are added up. Storing a rounded running total would let two phones drift
 * apart, which is the same reason bird counts are derived.
 */

import { z } from 'zod';
import { isoTimestampSchema } from './poultry.js';

export const EXPENSE_CATEGORIES = [
  'feed',
  'chicks',
  'labour',
  'veterinary',
  'transport',
  'utilities',
  'repairs',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  feed: 'Feed',
  chicks: 'Chicks',
  labour: 'Labour',
  veterinary: 'Veterinary',
  transport: 'Transport',
  utilities: 'Utilities',
  repairs: 'Repairs',
  other: 'Other',
};

export const EXPENSE_METHODS = ['cash', 'mpesa', 'bank', 'other'] as const;

export type ExpenseMethod = (typeof EXPENSE_METHODS)[number];

export const EXPENSE_METHOD_LABELS: Record<ExpenseMethod, string> = {
  cash: 'Cash',
  mpesa: 'M-Pesa',
  bank: 'Bank',
  other: 'Other',
};

export function roundKes(value: number): number {
  return Math.round(value * 100) / 100;
}

export function sumKes(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return roundKes(total);
}

export interface PricedSale {
  count: number;
  unitPriceKes?: number | null | undefined;
}

/**
 * Revenue for one sale, or null when the sale was recorded before prices
 * existed. Null is deliberate: an unpriced sale must not silently count as
 * zero, or the month would look worse than it was without warning.
 */
export function saleRevenueKes(sale: PricedSale): number | null {
  if (sale.unitPriceKes === null || sale.unitPriceKes === undefined) return null;
  return roundKes(sale.count * sale.unitPriceKes);
}

export interface ExpenseLike {
  id: string;
  category: ExpenseCategory;
  amountKes: number;
  batchId?: string | null;
}

export interface ExpenseApprovalLike {
  expenseId: string;
  decision: 'approved' | 'rejected';
}

export function totalExpensesKes(expenses: ReadonlyArray<{ amountKes: number }>): number {
  return sumKes(expenses.map((expense) => expense.amountKes));
}

export function expensesByCategory(
  expenses: ReadonlyArray<ExpenseLike>,
): Array<{ category: ExpenseCategory; totalKes: number }> {
  const totals = new Map<ExpenseCategory, number>();
  for (const expense of expenses) {
    totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amountKes);
  }
  return EXPENSE_CATEGORIES.filter((category) => totals.has(category)).map((category) => ({
    category,
    totalKes: roundKes(totals.get(category) ?? 0),
  }));
}

export type ExpenseApprovalState = 'pending' | 'approved' | 'rejected';

export function approvalFor(
  expenseId: string,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
): ExpenseApprovalLike | undefined {
  return approvals.find((approval) => approval.expenseId === expenseId);
}

export function expenseState(
  expenseId: string,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
): ExpenseApprovalState {
  return approvalFor(expenseId, approvals)?.decision ?? 'pending';
}

export interface BatchFinance {
  /** Revenue from priced sales only. */
  revenueKes: number;
  /** Approved expenses tagged to this batch. */
  expensesKes: number;
  marginKes: number;
  /** Sales with no price, so the owner knows revenue is incomplete. */
  unpricedSales: number;
}

export function batchFinance(
  batchId: string,
  sales: ReadonlyArray<PricedSale & { batchId: string }>,
  expenses: ReadonlyArray<ExpenseLike>,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
): BatchFinance {
  const batchSales = sales.filter((sale) => sale.batchId === batchId);
  const priced = batchSales
    .map((sale) => saleRevenueKes(sale))
    .filter((value): value is number => value !== null);
  const approved = expenses.filter(
    (expense) => expense.batchId === batchId && expenseState(expense.id, approvals) === 'approved',
  );
  const revenueKes = sumKes(priced);
  const expensesKes = totalExpensesKes(approved);
  return {
    revenueKes,
    expensesKes,
    marginKes: roundKes(revenueKes - expensesKes),
    unpricedSales: batchSales.length - priced.length,
  };
}

// ---------------------------------------------------------------- schemas ---

const uuid = z.string().uuid('That is not a valid id.');
const trimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, message);

export const expenseInputSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amountKes: z
    .number()
    .positive('Enter an amount.')
    .max(100_000_000, 'That amount is too large.'),
  paidTo: trimmed(0, 120, 'Keep the payee under 120 characters.').optional(),
  method: z.enum(EXPENSE_METHODS).default('cash'),
  batchId: uuid.optional(),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
});

export const DECISIONS = ['approved', 'rejected'] as const;

export const expenseApprovalInputSchema = z.object({
  expenseId: uuid,
  decision: z.enum(DECISIONS),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
});

export type ExpenseInput = z.infer<typeof expenseInputSchema>;
export type ExpenseApprovalInput = z.infer<typeof expenseApprovalInputSchema>;
