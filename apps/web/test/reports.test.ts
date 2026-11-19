import { describe, expect, it } from 'vitest';
import type {
  Batch,
  BatchWeight,
  BirdReturn,
  BirdSale,
  BirdTransfer,
  Expense,
  ExpenseApproval,
  House,
  MortalityEvent,
  SalesAllocation,
  StockMovement,
} from '../src/local.js';
import {
  buildFarmReport,
  isInPeriod,
  periodFor,
  type ReportInput,
  type ReportPeriod,
} from '../src/reports.js';

/**
 * The report is derived from the phone's events, so these cases pin down the
 * period edges, the mortality denominator, the finance privacy gate and the
 * salesperson arithmetic.
 */

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

const house = (over: Partial<House> = {}): House => ({
  id: 'h1',
  name: 'House A',
  note: null,
  dirty: false,
  ...over,
});

const batch = (over: Partial<Batch> = {}): Batch => ({
  id: 'b1',
  houseId: 'h1',
  code: 'B-1',
  breed: null,
  arrivalDate: '2026-04-01',
  initialCount: 100,
  status: 'active',
  note: null,
  dirty: false,
  ...over,
});

const death = (over: Partial<MortalityEvent> = {}): MortalityEvent => ({
  id: nextId('m'),
  batchId: 'b1',
  count: 1,
  cause: null,
  causeCategory: null,
  recordedAt: '2026-05-02T08:00:00.000Z',
  dirty: false,
  ...over,
});

const sale = (over: Partial<BirdSale> = {}): BirdSale => ({
  id: nextId('s'),
  batchId: 'b1',
  allocationId: null,
  count: 1,
  buyer: null,
  note: null,
  unitPriceKes: 500,
  recordedAt: '2026-05-03T08:00:00.000Z',
  dirty: false,
  ...over,
});

const transfer = (over: Partial<BirdTransfer> = {}): BirdTransfer => ({
  id: nextId('t'),
  fromBatchId: 'b1',
  toBatchId: 'b2',
  count: 1,
  note: null,
  recordedAt: '2026-05-02T08:00:00.000Z',
  dirty: false,
  ...over,
});

const allocation = (over: Partial<SalesAllocation> = {}): SalesAllocation => ({
  id: nextId('a'),
  batchId: 'b1',
  salespersonId: 'u1',
  count: 10,
  note: null,
  recordedAt: '2026-05-02T08:00:00.000Z',
  dirty: false,
  ...over,
});

const returned = (over: Partial<BirdReturn> = {}): BirdReturn => ({
  id: nextId('r'),
  allocationId: 'a1',
  count: 1,
  reason: null,
  recordedAt: '2026-05-05T08:00:00.000Z',
  dirty: false,
  ...over,
});

const movement = (over: Partial<StockMovement> = {}): StockMovement => ({
  id: nextId('sm'),
  stockItemId: 'feed',
  kind: 'issue',
  quantityKg: 1,
  batchId: 'b1',
  allocationId: null,
  unitCostKesPerKg: null,
  note: null,
  recordedAt: '2026-05-05T08:00:00.000Z',
  dirty: false,
  ...over,
});

const weight = (over: Partial<BatchWeight> = {}): BatchWeight => ({
  id: nextId('w'),
  batchId: 'b1',
  sampleCount: 20,
  averageWeightKg: 1.85,
  note: null,
  recordedAt: '2026-05-10T08:00:00.000Z',
  dirty: false,
  ...over,
});

const expense = (over: Partial<Expense> = {}): Expense => ({
  id: nextId('e'),
  category: 'feed',
  amountKes: 100,
  paidTo: null,
  method: 'cash',
  batchId: 'b1',
  note: null,
  recordedAt: '2026-05-06T08:00:00.000Z',
  dirty: false,
  ...over,
});

const approval = (expenseId: string, decision: 'approved' | 'rejected'): ExpenseApproval => ({
  id: nextId('ap'),
  expenseId,
  decision,
  note: null,
  recordedAt: '2026-05-06T09:00:00.000Z',
  dirty: false,
});

function makeInput(over: Partial<ReportInput> = {}): ReportInput {
  return {
    batches: [],
    houses: [house()],
    mortality: [],
    transfers: [],
    sales: [],
    allocations: [],
    returns: [],
    movements: [],
    weights: [],
    expenses: [],
    approvals: [],
    team: [],
    ...over,
  };
}

const MAY: ReportPeriod = periodFor('thisMonth', '2026-05-31');

describe('periods', () => {
  it('builds inclusive month and rolling week ranges', () => {
    expect(periodFor('thisMonth', '2026-05-15')).toMatchObject({
      startDay: '2026-05-01',
      endDay: '2026-05-15',
    });
    expect(periodFor('last7', '2026-05-15')).toMatchObject({
      startDay: '2026-05-09',
      endDay: '2026-05-15',
    });
    expect(periodFor('last30', '2026-05-15')).toMatchObject({
      startDay: '2026-04-16',
      endDay: '2026-05-15',
    });
    expect(periodFor('last90', '2026-05-15')).toMatchObject({
      startDay: '2026-02-15',
      endDay: '2026-05-15',
    });
  });

  it('crosses a year boundary and keeps the last day in', () => {
    expect(periodFor('last30', '2026-01-10')).toMatchObject({
      startDay: '2025-12-12',
      endDay: '2026-01-10',
    });
    expect(isInPeriod('2026-05-01T23:59:59.000Z', MAY)).toBe(true);
    expect(isInPeriod('2026-05-01T00:00:00.000Z', MAY)).toBe(true);
    expect(isInPeriod('2026-06-01T00:00:00.000Z', MAY)).toBe(false);
    expect(isInPeriod('2026-04-30T23:59:59.000Z', MAY)).toBe(false);
  });
});

describe('period summary', () => {
  const input = makeInput({
    batches: [batch()],
    mortality: [death({ count: 4, causeCategory: 'disease' }), death({ count: 10, recordedAt: '2026-04-20T08:00:00.000Z' })],
    sales: [
      sale({ count: 10, unitPriceKes: 500 }),
      sale({ count: 5, unitPriceKes: null, recordedAt: '2026-05-04T08:00:00.000Z' }),
      sale({ count: 2, unitPriceKes: 450, recordedAt: '2026-04-25T08:00:00.000Z' }),
    ],
    movements: [
      movement({ quantityKg: 20 }),
      movement({ kind: 'receipt', quantityKg: 100 }),
      movement({ quantityKg: 5, recordedAt: '2026-04-28T08:00:00.000Z' }),
    ],
    expenses: [
      expense({ amountKes: 1200 }),
      expense({ amountKes: 800, recordedAt: '2026-05-07T08:00:00.000Z' }),
      expense({ amountKes: 300, recordedAt: '2026-05-08T08:00:00.000Z' }),
      expense({ amountKes: 400, recordedAt: '2026-04-28T08:00:00.000Z' }),
    ],
  });
  // The second expense stays pending; only the first is approved in the period.
  const approved = input.expenses.flatMap((item, index) =>
    index === 1 ? [] : [approval(item.id, index === 2 ? 'rejected' : 'approved')],
  );

  it('counts priced revenue, approved spend and the period events', () => {
    const report = buildFarmReport({ ...input, approvals: approved }, MAY, {
      includeFinance: true,
    });
    expect(report.summary).toMatchObject({
      birdsSold: 15,
      mortalityCount: 4,
      mortalityRatePct: 4.55,
      feedUsedKg: 20,
      revenueKes: 5000,
      spendKes: 1200,
      netKes: 3800,
      unpricedSales: 1,
    });
  });

  it('computes a batch row from the period, with live birds as a snapshot', () => {
    const report = buildFarmReport({ ...input, approvals: approved }, MAY, {
      includeFinance: true,
    });
    expect(report.batches[0]).toMatchObject({
      code: 'B-1',
      houseName: 'House A',
      live: 69,
      mortality: 4,
      mortalityRatePct: 4.55,
      sold: 15,
      feedUsedKg: 20,
      feedPerBirdKg: 1.33,
      revenueKes: 5000,
      expensesKes: 1200,
      marginKes: 3800,
      unpricedSales: 1,
    });
  });

  it('groups deaths by cause and by batch', () => {
    const report = buildFarmReport({ ...input, approvals: approved }, MAY, {
      includeFinance: false,
    });
    expect(report.mortality.byCause).toEqual([
      { category: 'disease', label: 'Disease', birds: 4 },
    ]);
    expect(report.mortality.byBatch).toEqual([
      { batchId: 'b1', code: 'B-1', birds: 4, mortalityRatePct: 4.55 },
    ]);
  });

  it('warns about unpriced sales without counting them as revenue', () => {
    const report = buildFarmReport({ ...input, approvals: approved }, MAY, {
      includeFinance: true,
    });
    expect(report.summary.unpricedSales).toBe(1);
    expect(report.summary.revenueKes).toBe(5000);
  });
});

describe('denominators', () => {
  it('starts from the flock present when the period began', () => {
    // 100 arrived, 20 left in April, so 80 were at risk in May.
    const report = buildFarmReport(
      makeInput({
        batches: [batch()],
        transfers: [transfer({ fromBatchId: 'b1', toBatchId: 'b2', count: 20, recordedAt: '2026-04-20T08:00:00.000Z' })],
        mortality: [death({ count: 8 })],
      }),
      MAY,
      { includeFinance: false },
    );
    expect(report.summary.mortalityRatePct).toBe(10);
    expect(report.batches[0]?.live).toBe(72);
  });

  it('adds birds transferred in during the period', () => {
    const report = buildFarmReport(
      makeInput({
        batches: [batch(), batch({ id: 'b2', code: 'B-2', initialCount: 0, arrivalDate: '2026-04-01' })],
        transfers: [transfer({ fromBatchId: 'b2', toBatchId: 'b1', count: 10 })],
        mortality: [death({ count: 9 })],
      }),
      MAY,
      { includeFinance: false },
    );
    // 100 at the start plus 10 arrivals = 110 at risk.
    expect(report.summary.mortalityRatePct).toBe(8.18);
  });

  it('uses the arrival count for a batch that arrived inside the period', () => {
    const report = buildFarmReport(
      makeInput({
        batches: [batch({ id: 'b2', code: 'B-2', arrivalDate: '2026-05-10', initialCount: 50 })],
        mortality: [death({ batchId: 'b2', count: 5, recordedAt: '2026-05-12T08:00:00.000Z' })],
      }),
      MAY,
      { includeFinance: false },
    );
    expect(report.batches[0]?.mortalityRatePct).toBe(10);
  });
});

describe('finance privacy', () => {
  const input = makeInput({
    batches: [batch()],
    sales: [sale({ count: 4, unitPriceKes: 500 })],
    expenses: [expense({ amountKes: 300 })],
  });
  const approvals = [approval(input.expenses[0]!.id, 'approved')];

  it('leaves every money figure out when finance is hidden', () => {
    const report = buildFarmReport({ ...input, approvals }, MAY, { includeFinance: false });
    expect(report.finance).toBeNull();
    expect(report.summary).toMatchObject({
      birdsSold: 4,
      revenueKes: null,
      spendKes: null,
      netKes: null,
      unpricedSales: 0,
    });
    expect(report.batches[0]).toMatchObject({
      revenueKes: null,
      expensesKes: null,
      marginKes: null,
    });
  });

  it('builds category totals and a zero-filled trend only with access', () => {
    const report = buildFarmReport({ ...input, approvals }, MAY, { includeFinance: true });
    expect(report.finance?.byCategory).toEqual([
      { category: 'feed', totalKes: 300, label: 'Feed' },
    ]);
    expect(report.finance?.pendingCount).toBe(0);
    const trend = report.finance?.trend ?? [];
    expect(trend).toHaveLength(5);
    expect(trend[0]).toMatchObject({ startDay: '2026-05-01', endDay: '2026-05-03' });
    expect(trend[0]?.revenueKes).toBe(2000);
    expect(trend[1]?.spendKes).toBe(300);
    expect(trend[4]).toMatchObject({ revenueKes: 0, spendKes: 0, netKes: 0 });
  });

  it('reports pending expenses for the period', () => {
    const pending = expense({ amountKes: 90 });
    const report = buildFarmReport(
      { ...input, expenses: [...input.expenses, pending], approvals },
      MAY,
      { includeFinance: true },
    );
    expect(report.finance?.pendingCount).toBe(1);
    expect(report.finance?.spendKes).toBe(300);
  });
});

describe('salespeople', () => {
  const mine = allocation({ id: 'a1', count: 20 });
  const older = allocation({ id: 'a2', count: 10, recordedAt: '2026-04-20T08:00:00.000Z' });
  const input = makeInput({
    batches: [batch()],
    allocations: [mine, older],
    sales: [
      sale({ allocationId: 'a1', count: 5, unitPriceKes: 500 }),
      sale({ allocationId: 'a2', count: 2, unitPriceKes: null, recordedAt: '2026-05-04T08:00:00.000Z' }),
    ],
    returns: [returned({ allocationId: 'a1', count: 3 })],
    movements: [
      movement({ allocationId: 'a1', quantityKg: 5 }),
      movement({ allocationId: 'a2', quantityKg: 2, recordedAt: '2026-04-20T08:00:00.000Z' }),
    ],
    team: [{ id: 'u1', name: 'Amina' }],
  });

  it('aggregates handovers, sales, returns and feed for the period', () => {
    const report = buildFarmReport(input, MAY, { includeFinance: true });
    expect(report.salespeople).toEqual([
      {
        salespersonId: 'u1',
        name: 'Amina',
        handovers: 1,
        allocated: 20,
        sold: 7,
        returned: 3,
        feedKg: 5,
        feedPerBirdSoldKg: 0.71,
        stillOut: 20,
        revenueKes: 2500,
        unpricedSales: 1,
      },
    ]);
  });

  it('hides revenue but keeps counts when finance is hidden', () => {
    const report = buildFarmReport(input, MAY, { includeFinance: false });
    expect(report.salespeople[0]).toMatchObject({
      sold: 7,
      revenueKes: null,
      unpricedSales: 1,
    });
  });

  it('falls back to a neutral name and still lists a missing team member', () => {
    const report = buildFarmReport({ ...input, team: [] }, MAY, { includeFinance: false });
    expect(report.salespeople[0]?.name).toBe('Salesperson');
  });
});

describe('batch selection', () => {
  it('drops batches that arrived after the period and closed batches with no activity', () => {
    const report = buildFarmReport(
      makeInput({
        batches: [
          batch({ id: 'b1' }),
          batch({ id: 'b2', code: 'B-2', arrivalDate: '2026-06-10' }),
          batch({ id: 'b3', code: 'B-3', status: 'closed' }),
          batch({ id: 'b4', code: 'B-4', status: 'closed' }),
        ],
        sales: [sale({ batchId: 'b4', count: 1 })],
      }),
      MAY,
      { includeFinance: false },
    );
    expect(report.batches.map((row) => row.code)).toEqual(['B-1', 'B-4']);
  });

  it('treats feed per bird as unknown when nothing was sold', () => {
    const report = buildFarmReport(
      makeInput({
        batches: [batch()],
        movements: [movement({ quantityKg: 12 })],
      }),
      MAY,
      { includeFinance: false },
    );
    expect(report.batches[0]).toMatchObject({ feedUsedKg: 12, feedPerBirdKg: null });
  });
});

describe('feed cost and weight', () => {
  const input = makeInput({
    batches: [batch()],
    sales: [sale({ count: 4, unitPriceKes: 500 })],
    expenses: [expense({ amountKes: 300 })],
    movements: [
      movement({ kind: 'receipt', quantityKg: 100, unitCostKesPerKg: 60 }),
      movement({ quantityKg: 20 }),
    ],
    weights: [weight({ averageWeightKg: 2.4 })],
  });
  const approvals = [approval(input.expenses[0]!.id, 'approved')];

  it('values period feed at its delivery price and subtracts it from margin', () => {
    const report = buildFarmReport({ ...input, approvals }, MAY, { includeFinance: true });
    expect(report.batches[0]).toMatchObject({
      feedUsedKg: 20,
      feedCostKes: 1200,
      uncostedFeedKg: 0,
      revenueKes: 2000,
      expensesKes: 300,
      marginKes: 500,
      avgWeightKg: 2.4,
    });
  });

  it('reports feed with no delivery price instead of costing it as zero', () => {
    const report = buildFarmReport(
      makeInput({
        batches: [batch()],
        movements: [movement({ quantityKg: 7, stockItemId: 'unpriced' })],
      }),
      MAY,
      { includeFinance: true },
    );
    expect(report.batches[0]).toMatchObject({
      feedCostKes: 0,
      uncostedFeedKg: 7,
    });
  });

  it('hides feed cost with the rest of the money when finance is closed', () => {
    const report = buildFarmReport({ ...input, approvals }, MAY, { includeFinance: false });
    expect(report.batches[0]).toMatchObject({
      feedCostKes: null,
      marginKes: null,
      avgWeightKg: 2.4,
    });
  });
});
