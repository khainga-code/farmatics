import {
  expenseState,
  roundKes,
  saleRevenueKes,
  sumKes,
  type ExpenseApprovalLike,
  type Permission,
  type PricedSale,
} from '@farmatics/shared';

/**
 * The money the Home and Finance screens show.
 *
 * Both screens answer the same questions - what came in, what went out, what is
 * still waiting - so the arithmetic lives here once, with tests, instead of
 * being repeated in two components where it can drift.
 *
 * Revenue counts priced sales only. A sale with no price is reported as
 * unpriced, never counted as zero, so a month cannot quietly look worse.
 */

export interface MoneySale extends PricedSale {
  recordedAt: string;
}

export interface MoneyExpense {
  id: string;
  amountKes: number;
  recordedAt: string;
}

export interface PeriodMoney {
  revenueKes: number;
  spendKes: number;
  netKes: number;
  /** Sales in the period that have no price yet. */
  unpricedSales: number;
}

function periodMoney(
  sales: ReadonlyArray<MoneySale>,
  expenses: ReadonlyArray<MoneyExpense>,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
  inPeriod: (recordedAt: string) => boolean,
): PeriodMoney {
  const periodSales = sales.filter((sale) => inPeriod(sale.recordedAt));
  const revenueKes = sumKes(
    periodSales
      .map((sale) => saleRevenueKes(sale))
      .filter((value): value is number => value !== null),
  );
  const spendKes = sumKes(
    expenses
      .filter(
        (expense) =>
          inPeriod(expense.recordedAt) &&
          expenseState(expense.id, approvals) === 'approved',
      )
      .map((expense) => expense.amountKes),
  );

  return {
    revenueKes,
    spendKes,
    netKes: roundKes(revenueKes - spendKes),
    unpricedSales: periodSales.filter((sale) => saleRevenueKes(sale) === null).length,
  };
}

/** A calendar day, given as `YYYY-MM-DD`. */
export function dayMoney(
  sales: ReadonlyArray<MoneySale>,
  expenses: ReadonlyArray<MoneyExpense>,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
  day: string,
): PeriodMoney {
  return periodMoney(sales, expenses, approvals, (recordedAt) =>
    recordedAt.startsWith(day),
  );
}

/** A calendar month, given any date inside it as `YYYY-MM-DD`. */
export function monthMoney(
  sales: ReadonlyArray<MoneySale>,
  expenses: ReadonlyArray<MoneyExpense>,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
  day: string,
): PeriodMoney {
  const month = day.slice(0, 7);
  return periodMoney(sales, expenses, approvals, (recordedAt) =>
    recordedAt.startsWith(month),
  );
}

/** An inclusive range of calendar days, each given as `YYYY-MM-DD`. */
export function rangeMoney(
  sales: ReadonlyArray<MoneySale>,
  expenses: ReadonlyArray<MoneyExpense>,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
  startDay: string,
  endDay: string,
): PeriodMoney {
  return periodMoney(sales, expenses, approvals, (recordedAt) => {
    const day = recordedAt.slice(0, 10);
    return day >= startDay && day <= endDay;
  });
}

export function pendingExpenseCount(
  expenses: ReadonlyArray<{ id: string }>,
  approvals: ReadonlyArray<ExpenseApprovalLike>,
): number {
  return expenses.filter((expense) => expenseState(expense.id, approvals) === 'pending')
    .length;
}

/** Who may open the cash book, on the server and on this screen. */
export function canSeeFinance(permissions: readonly Permission[]): boolean {
  return permissions.includes('view_finance') || permissions.includes('record_expense');
}
