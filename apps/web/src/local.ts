import { useCallback, useEffect, useState } from 'react';
import type { LocalRecord } from '@farmatics/sync';
import {
  allocationBalance,
  batchCounts,
  stockOnHand,
  type AllocationBalance,
  type ExpenseCategory,
  type ExpenseMethod,
  type MortalityCauseCategory,
  type StockMovementKind,
} from '@farmatics/shared';
import { syncClient } from './offline.js';

/**
 * Reading the phone's own database.
 *
 * Every screen reads from Dexie, never from the network. That is what makes a
 * batch list work with no signal. The hook re-reads whenever the sync client
 * says something changed - a local save, a push acknowledgement, or a pull
 * from another phone.
 */

const TABLES = [
  'houses',
  'batches',
  'mortality_events',
  'bird_transfers',
  'bird_sales',
  'sales_allocations',
  'bird_returns',
  'vaccination_events',
  'stock_items',
  'stock_movements',
  'expenses',
  'expense_approvals',
] as const;

export type TableName = (typeof TABLES)[number];

export type FarmData = Record<TableName, LocalRecord[]>;

function emptyFarmData(): FarmData {
  return {
    houses: [],
    batches: [],
    mortality_events: [],
    bird_transfers: [],
    bird_sales: [],
    sales_allocations: [],
    bird_returns: [],
    vaccination_events: [],
    stock_items: [],
    stock_movements: [],
    expenses: [],
    expense_approvals: [],
  };
}

export function useFarmData(): {
  data: FarmData;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<FarmData>(emptyFarmData);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const lists = await Promise.all(TABLES.map((table) => syncClient.listRecords(table)));
    const next = emptyFarmData();
    TABLES.forEach((table, index) => {
      next[table] = (lists[index] ?? []).filter((record) => record.deletedAt === null);
    });
    setData(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    return syncClient.subscribe(() => {
      void reload();
    });
  }, [reload]);

  return { data, loading, reload };
}

// ------------------------------------------------------------- readers ---

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const maybeText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const count = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export interface House {
  id: string;
  name: string;
  note: string | null;
  dirty: boolean;
}

export interface Batch {
  id: string;
  houseId: string;
  code: string;
  breed: string | null;
  arrivalDate: string;
  initialCount: number;
  status: string;
  note: string | null;
  dirty: boolean;
}

interface EventBase {
  id: string;
  recordedAt: string;
  dirty: boolean;
}

export interface MortalityEvent extends EventBase {
  batchId: string;
  count: number;
  cause: string | null;
  /** Null on rows recorded before categories existed. */
  causeCategory: MortalityCauseCategory | null;
}

export interface BirdTransfer extends EventBase {
  fromBatchId: string;
  toBatchId: string;
  count: number;
  note: string | null;
}

export interface BirdSale extends EventBase {
  batchId: string;
  allocationId: string | null;
  count: number;
  buyer: string | null;
  note: string | null;
  unitPriceKes: number | null;
}

export interface SalesAllocation extends EventBase {
  batchId: string;
  salespersonId: string;
  count: number;
  note: string | null;
}

export interface BirdReturn extends EventBase {
  allocationId: string;
  count: number;
  reason: string | null;
}

export interface VaccinationEvent extends EventBase {
  batchId: string;
  day: number;
  note: string | null;
}

export interface StockItem {
  id: string;
  name: string;
  unit: string;
  reorderLevelKg: number | null;
  active: boolean;
  dirty: boolean;
}

export interface StockMovement extends EventBase {
  stockItemId: string;
  kind: StockMovementKind;
  quantityKg: number;
  batchId: string | null;
  /** Set when the feed went out with a salesperson's allocation. */
  allocationId: string | null;
  note: string | null;
}

export function toHouses(records: LocalRecord[]): House[] {
  return records.map((record) => ({
    id: record.id,
    name: text(record.data['name']),
    note: maybeText(record.data['note']),
    dirty: record.dirty,
  }));
}

export function toBatches(records: LocalRecord[]): Batch[] {
  return records.map((record) => ({
    id: record.id,
    houseId: text(record.data['houseId']),
    code: text(record.data['code']),
    breed: maybeText(record.data['breed']),
    arrivalDate: text(record.data['arrivalDate']).slice(0, 10),
    initialCount: count(record.data['initialCount']),
    status: text(record.data['status']) || 'active',
    note: maybeText(record.data['note']),
    dirty: record.dirty,
  }));
}

export function toMortality(records: LocalRecord[]): MortalityEvent[] {
  return records.map((record) => ({
    id: record.id,
    batchId: text(record.data['batchId']),
    count: count(record.data['count']),
    cause: maybeText(record.data['cause']),
    causeCategory: (record.data['causeCategory'] ?? null) as MortalityCauseCategory | null,
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export function toTransfers(records: LocalRecord[]): BirdTransfer[] {
  return records.map((record) => ({
    id: record.id,
    fromBatchId: text(record.data['fromBatchId']),
    toBatchId: text(record.data['toBatchId']),
    count: count(record.data['count']),
    note: maybeText(record.data['note']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export function toSales(records: LocalRecord[]): BirdSale[] {
  return records.map((record) => ({
    id: record.id,
    batchId: text(record.data['batchId']),
    allocationId: maybeText(record.data['allocationId']),
    count: count(record.data['count']),
    buyer: maybeText(record.data['buyer']),
    note: maybeText(record.data['note']),
    unitPriceKes:
      record.data['unitPriceKes'] === null || record.data['unitPriceKes'] === undefined
        ? null
        : count(record.data['unitPriceKes']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export function toAllocations(records: LocalRecord[]): SalesAllocation[] {
  return records.map((record) => ({
    id: record.id,
    batchId: text(record.data['batchId']),
    salespersonId: text(record.data['salespersonId']),
    count: count(record.data['count']),
    note: maybeText(record.data['note']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export function toReturns(records: LocalRecord[]): BirdReturn[] {
  return records.map((record) => ({
    id: record.id,
    allocationId: text(record.data['allocationId']),
    count: count(record.data['count']),
    reason: maybeText(record.data['reason']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export function toVaccinations(records: LocalRecord[]): VaccinationEvent[] {
  return records.map((record) => ({
    id: record.id,
    batchId: text(record.data['batchId']),
    day: count(record.data['day']),
    note: maybeText(record.data['note']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export function toStockItems(records: LocalRecord[]): StockItem[] {
  return records.map((record) => ({
    id: record.id,
    name: text(record.data['name']),
    unit: text(record.data['unit']) || 'kg',
    reorderLevelKg:
      record.data['reorderLevelKg'] === null || record.data['reorderLevelKg'] === undefined
        ? null
        : count(record.data['reorderLevelKg']),
    active: record.data['active'] !== false,
    dirty: record.dirty,
  }));
}

export function toStockMovements(records: LocalRecord[]): StockMovement[] {
  return records.map((record) => ({
    id: record.id,
    stockItemId: text(record.data['stockItemId']),
    kind: text(record.data['kind']) as StockMovementKind,
    quantityKg: count(record.data['quantityKg']),
    batchId: maybeText(record.data['batchId']),
    allocationId: maybeText(record.data['allocationId']),
    note: maybeText(record.data['note']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export interface Expense extends EventBase {
  category: ExpenseCategory;
  amountKes: number;
  paidTo: string | null;
  method: ExpenseMethod;
  batchId: string | null;
  note: string | null;
}

export interface ExpenseApproval extends EventBase {
  expenseId: string;
  decision: 'approved' | 'rejected';
  note: string | null;
}

export function toExpenses(records: LocalRecord[]): Expense[] {
  return records.map((record) => ({
    id: record.id,
    category: (text(record.data['category']) || 'other') as ExpenseCategory,
    amountKes: count(record.data['amountKes']),
    paidTo: maybeText(record.data['paidTo']),
    method: (text(record.data['method']) || 'cash') as ExpenseMethod,
    batchId: maybeText(record.data['batchId']),
    note: maybeText(record.data['note']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

export function toExpenseApprovals(records: LocalRecord[]): ExpenseApproval[] {
  return records.map((record) => ({
    id: record.id,
    expenseId: text(record.data['expenseId']),
    decision: text(record.data['decision']) === 'rejected' ? 'rejected' : 'approved',
    note: maybeText(record.data['note']),
    recordedAt: text(record.data['recordedAt']),
    dirty: record.dirty,
  }));
}

// ------------------------------------------------------------ balances ---

export interface BatchBalance {
  initial: number;
  live: number;
  mortality: number;
  sold: number;
  transferredOut: number;
  transferredIn: number;
}

/** The same derivation the server makes, from the phone's own events. */
export function balanceFor(
  batch: Batch,
  mortality: MortalityEvent[],
  sales: BirdSale[],
  transfers: BirdTransfer[],
): BatchBalance {
  return batchCounts({
    initialCount: batch.initialCount,
    mortality: mortality.filter((event) => event.batchId === batch.id).map((event) => event.count),
    sold: sales.filter((event) => event.batchId === batch.id).map((event) => event.count),
    transferredOut: transfers
      .filter((event) => event.fromBatchId === batch.id)
      .map((event) => event.count),
    transferredIn: transfers
      .filter((event) => event.toBatchId === batch.id)
      .map((event) => event.count),
  });
}

/** Remaining birds on one allocation, derived from the phone's own events. */
export function allocationBalanceFor(
  allocation: SalesAllocation,
  sales: BirdSale[],
  returns: BirdReturn[],
): AllocationBalance {
  return allocationBalance({
    allocated: allocation.count,
    sold: sales
      .filter((sale) => sale.allocationId === allocation.id)
      .map((sale) => sale.count),
    returned: returns
      .filter((event) => event.allocationId === allocation.id)
      .map((event) => event.count),
  });
}

/** Feed issued with one allocation, in kilograms. Derived from the store. */
export function feedAllocatedFor(allocationId: string, movements: StockMovement[]): number {
  const issued = movements
    .filter(
      (movement) => movement.kind === 'issue' && movement.allocationId === allocationId,
    )
    .reduce((total, movement) => total + movement.quantityKg, 0);
  return Math.round(issued * 100) / 100;
}

export function feedUsedBy(batchId: string, movements: StockMovement[]): number {
  const used = movements
    .filter((movement) => movement.kind === 'issue' && movement.batchId === batchId)
    .reduce((total, movement) => total + movement.quantityKg, 0);
  return Math.round(used * 100) / 100;
}

export function onHandFor(itemId: string, movements: StockMovement[]): number {
  return stockOnHand(
    movements
      .filter((movement) => movement.stockItemId === itemId)
      .map((movement) => ({ kind: movement.kind, quantityKg: movement.quantityKg })),
  );
}
