import type { Db } from '@farmatics/db';
import {
  allocationInputSchema,
  batchInputSchema,
  birdReturnInputSchema,
  expenseApprovalInputSchema,
  expenseInputSchema,
  houseInputSchema,
  mortalityInputSchema,
  saleInputSchema,
  saleOpensOn,
  stockItemInputSchema,
  stockMovementInputSchema,
  toDateOnly,
  transferInputSchema,
  vaccinationInputSchema,
  weightInputSchema,
  type AllocationInput,
  type BatchInput,
  type BirdReturnInput,
  type ExpenseApprovalInput,
  type ExpenseInput,
  type HouseInput,
  type MortalityInput,
  type Permission,
  type Role,
  type SaleInput,
  type StockItemInput,
  type StockMovementInput,
  type SyncChange,
  type TransferInput,
  type VaccinationInput,
  type WeightInput,
} from '@farmatics/shared';
import { z } from 'zod';

/**
 * The sync entity registry.
 *
 * Every table a phone may push to is described here: how to validate a record,
 * who may write it, how to insert it idempotently, and how to render it back
 * for a pull. A new module means a new entry, never a new endpoint shape.
 *
 * Business rules that need other rows - "a sale before day 22", "not more
 * deaths than birds" - run inside the same tenant transaction as the insert.
 * Throwing `SyncValidationError` rolls the record back and tells the phone why,
 * without failing the rest of the batch.
 */

export class SyncValidationError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncValidationError';
  }
}

export interface SyncEntityContext {
  farmId: string;
  userId: string;
  role: Role;
  deviceId: string | null;
  /** Server clock at the moment the push arrived. */
  now: Date;
}

export interface SyncEntity {
  table: string;
  /** Validates the client-supplied business fields only. */
  schema: z.ZodType<unknown>;
  /** Any one of these lets the caller write the record. */
  permissionsFor(data: unknown): Permission[];
  /**
   * Any one of these lets a pull include this table. Empty or absent means
   * every signed-in member may read it. Finance tables set this so a phone
   * without the permission never receives the rows at all.
   */
  readPermissions?: Permission[];
  insert(
    tx: Db,
    ctx: SyncEntityContext,
    id: string,
    data: unknown,
  ): Promise<{ changeSeq: string } | null>;
  toChange(row: Record<string, unknown>): SyncChange;
}

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asDateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

/** Accepts any string Date.parse understands, but stores a real timestamp. */
const isoTimestamp = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Use an ISO date and time.')
  .transform((value) => new Date(value));

const probeSchema = z.object({
  label: z.string().trim().min(1, 'Give the probe a label.').max(120),
  value: z.number().int().min(-1_000_000).max(1_000_000),
  /** When the event happened, according to the phone. */
  recordedAt: isoTimestamp,
  /** The phone clock at push time; used to spot a wildly wrong device clock. */
  clientTime: isoTimestamp.optional(),
});

type ProbeInput = z.infer<typeof probeSchema>;

const probeEntity: SyncEntity = {
  table: 'probes',
  schema: probeSchema,
  permissionsFor: () => [],

  async insert(tx, ctx, id, data) {
    const input = data as ProbeInput;
    const clientTime = input.clientTime ?? ctx.now;
    const skewSeconds = Math.round((ctx.now.getTime() - clientTime.getTime()) / 1000);

    // `on conflict do nothing` is the whole idempotency story. A retried
    // outbox entry conflicts with itself, inserts nothing, and is reported
    // as a duplicate rather than being counted twice.
    const row = await tx.one<{ change_seq: string }>(
      `insert into probes
         (id, farm_id, label, value, recorded_at, recorded_by, client_time, clock_skew_seconds)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do nothing
       returning change_seq`,
      [
        id,
        ctx.farmId,
        input.label,
        input.value,
        input.recordedAt,
        ctx.userId,
        clientTime,
        skewSeconds,
      ],
    );

    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'probes',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        label: row['label'],
        value: row['value'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
        clockSkewSeconds: row['clock_skew_seconds'],
      },
    };
  },
};

/** `on conflict (id) do nothing` plus the change sequence, for every table. */
async function insertOne(
  tx: Db,
  table: string,
  columns: Record<string, unknown>,
  returning = 'change_seq',
): Promise<{ change_seq: string } | null> {
  const names = Object.keys(columns);
  const params = names.map((name) => columns[name]);
  const placeholders = names.map((_, index) => `$${index + 1}`);
  return tx.one<{ change_seq: string }>(
    `insert into ${table} (${names.join(', ')})
     values (${placeholders.join(', ')})
     on conflict (id) do nothing
     returning ${returning}`,
    params,
  );
}

async function requireBatch(
  tx: Db,
  farmId: string,
  batchId: unknown,
  label = 'batch',
): Promise<{ id: string; arrival_date: string; initial_count: number }> {
  const row = await tx.one<{ id: string; arrival_date: unknown; initial_count: number }>(
    'select id, arrival_date, initial_count from batches where id = $1 and farm_id = $2',
    [batchId, farmId],
  );
  if (!row) {
    throw new SyncValidationError(
      'unknown_batch',
      `That ${label} is not on this farm. Refresh and choose it again.`,
    );
  }
  return { id: row.id, arrival_date: asDateOnly(row.arrival_date)!, initial_count: row.initial_count };
}

/**
 * Birds alive, computed from the events. The same query backs the phone's
 * display, so the server and the screen cannot disagree.
 */
async function liveCount(tx: Db, farmId: string, batchId: string): Promise<number> {
  const row = await tx.one<{ live: string }>(
    `select
       b.initial_count
       - coalesce((select sum(count) from mortality_events where batch_id = b.id and deleted_at is null), 0)
       - coalesce((select sum(count) from bird_sales where batch_id = b.id and deleted_at is null), 0)
       - coalesce((select sum(count) from bird_transfers where from_batch_id = b.id and deleted_at is null), 0)
       + coalesce((select sum(count) from bird_transfers where to_batch_id = b.id and deleted_at is null), 0)
       as live
     from batches b
     where b.id = $1 and b.farm_id = $2`,
    [batchId, farmId],
  );
  return Number(row?.live ?? 0);
}

async function assertNotNegative(tx: Db, farmId: string, batchId: string): Promise<void> {
  const live = await liveCount(tx, farmId, batchId);
  if (live < 0) {
    throw new SyncValidationError(
      'not_enough_birds',
      'That would take the batch below zero birds. Check the count and try again.',
    );
  }
}

async function requireAllocation(
  tx: Db,
  farmId: string,
  allocationId: unknown,
): Promise<{ id: string; batch_id: string; salesperson_id: string; count: number }> {
  const row = await tx.one<{
    id: string;
    batch_id: string;
    salesperson_id: string;
    count: number;
  }>(
    `select id, batch_id, salesperson_id, count
       from sales_allocations
      where id = $1 and farm_id = $2 and deleted_at is null`,
    [allocationId, farmId],
  );
  if (!row) {
    throw new SyncValidationError(
      'unknown_allocation',
      'That allocation is not on this farm. Refresh and choose it again.',
    );
  }
  return row;
}

async function allocationUsed(
  tx: Db,
  allocationId: string,
): Promise<{ sold: number; returned: number }> {
  const row = await tx.one<{ sold: string; returned: string }>(
    `select
       coalesce((select sum(count) from bird_sales
                  where allocation_id = $1 and deleted_at is null), 0) as sold,
       coalesce((select sum(count) from bird_returns
                  where allocation_id = $1 and deleted_at is null), 0) as returned`,
    [allocationId],
  );
  return { sold: Number(row?.sold ?? 0), returned: Number(row?.returned ?? 0) };
}

/**
 * Birds already promised to salespeople but not yet sold or returned. A new
 * allocation may not push this past the birds currently alive.
 */
async function batchOutstanding(tx: Db, batchId: string): Promise<number> {
  const row = await tx.one<{ outstanding: string }>(
    `select
       coalesce((select sum(count) from sales_allocations
                  where batch_id = $1 and deleted_at is null), 0)
       - coalesce((select sum(count) from bird_sales
                    where batch_id = $1 and allocation_id is not null and deleted_at is null), 0)
       - coalesce((select sum(r.count) from bird_returns r
                     join sales_allocations a on a.id = r.allocation_id
                    where a.batch_id = $1 and r.deleted_at is null), 0) as outstanding`,
    [batchId],
  );
  return Number(row?.outstanding ?? 0);
}

function eventColumns(
  ctx: SyncEntityContext,
  data: { recordedAt: string; clientTime?: string | undefined },
) {
  const clientTime = data.clientTime ? new Date(data.clientTime) : ctx.now;
  return {
    recorded_at: new Date(data.recordedAt),
    recorded_by: ctx.userId,
    client_time: clientTime,
    clock_skew_seconds: Math.round((ctx.now.getTime() - clientTime.getTime()) / 1000),
  };
}

const houseEntity: SyncEntity = {
  table: 'houses',
  schema: houseInputSchema,
  permissionsFor: () => ['manage_setup'],

  async insert(tx, ctx, id, data) {
    const input = data as HouseInput;
    const row = await insertOne(tx, 'houses', {
      id,
      farm_id: ctx.farmId,
      name: input.name,
      note: input.note ?? null,
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'houses',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: { name: row['name'], note: row['note'] },
    };
  },
};

const batchEntity: SyncEntity = {
  table: 'batches',
  schema: batchInputSchema,
  permissionsFor: () => ['manage_setup'],

  async insert(tx, ctx, id, data) {
    const input = data as BatchInput;

    const house = await tx.one<{ id: string }>(
      'select id from houses where id = $1 and farm_id = $2',
      [input.houseId, ctx.farmId],
    );
    if (!house) {
      throw new SyncValidationError(
        'unknown_house',
        'That house is not on this farm. Refresh and choose it again.',
      );
    }

    try {
      const row = await insertOne(tx, 'batches', {
        id,
        farm_id: ctx.farmId,
        house_id: input.houseId,
        code: input.code,
        breed: input.breed ?? null,
        arrival_date: input.arrivalDate,
        initial_count: input.initialCount,
        note: input.note ?? null,
      });
      return row ? { changeSeq: String(row.change_seq) } : null;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new SyncValidationError(
          'duplicate_batch_code',
          'Another batch already uses that code. Give this one a different code.',
        );
      }
      throw error;
    }
  },

  toChange(row) {
    return {
      table: 'batches',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        houseId: row['house_id'],
        code: row['code'],
        breed: row['breed'],
        arrivalDate: asDateOnly(row['arrival_date']),
        initialCount: num(row['initial_count']),
        status: row['status'],
        note: row['note'],
      },
    };
  },
};

const mortalityEntity: SyncEntity = {
  table: 'mortality_events',
  schema: mortalityInputSchema,
  permissionsFor: () => ['record_mortality'],

  async insert(tx, ctx, id, data) {
    const input = data as MortalityInput;
    await requireBatch(tx, ctx.farmId, input.batchId);

    const row = await insertOne(tx, 'mortality_events', {
      id,
      farm_id: ctx.farmId,
      batch_id: input.batchId,
      count: input.count,
      cause: input.cause ?? null,
      cause_category: input.causeCategory ?? null,
      ...eventColumns(ctx, input),
    });
    if (!row) return null;

    await assertNotNegative(tx, ctx.farmId, input.batchId);
    return { changeSeq: String(row.change_seq) };
  },

  toChange(row) {
    return {
      table: 'mortality_events',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        batchId: row['batch_id'],
        count: num(row['count']),
        cause: row['cause'],
        causeCategory: row['cause_category'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const transferEntity: SyncEntity = {
  table: 'bird_transfers',
  schema: transferInputSchema,
  permissionsFor: () => ['record_transfer'],

  async insert(tx, ctx, id, data) {
    const input = data as TransferInput;
    await requireBatch(tx, ctx.farmId, input.fromBatchId, 'batch');
    await requireBatch(tx, ctx.farmId, input.toBatchId, 'receiving batch');

    const row = await insertOne(tx, 'bird_transfers', {
      id,
      farm_id: ctx.farmId,
      from_batch_id: input.fromBatchId,
      to_batch_id: input.toBatchId,
      count: input.count,
      note: input.note ?? null,
      ...eventColumns(ctx, input),
    });
    if (!row) return null;

    await assertNotNegative(tx, ctx.farmId, input.fromBatchId);
    return { changeSeq: String(row.change_seq) };
  },

  toChange(row) {
    return {
      table: 'bird_transfers',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        fromBatchId: row['from_batch_id'],
        toBatchId: row['to_batch_id'],
        count: num(row['count']),
        note: row['note'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const saleEntity: SyncEntity = {
  table: 'bird_sales',
  schema: saleInputSchema,
  permissionsFor: () => ['record_sale'],

  async insert(tx, ctx, id, data) {
    const input = data as SaleInput;
    const batch = await requireBatch(tx, ctx.farmId, input.batchId);

    // Day 22 is the first selling day. Compare the day the sale happened, not
    // the day the phone happened to reconnect.
    const saleDate = toDateOnly(input.recordedAt);
    const opensOn = saleOpensOn(batch.arrival_date);
    if (saleDate < opensOn) {
      throw new SyncValidationError(
        'sale_too_early',
        `Birds from this batch can be sold from ${opensOn} (day 22).`,
      );
    }

    // A salesperson sells only from their own allocation. The owner and the
    // farm manager may still record a walk-in sale with no allocation.
    if (input.allocationId) {
      const allocation = await requireAllocation(tx, ctx.farmId, input.allocationId);
      if (allocation.batch_id !== input.batchId) {
        throw new SyncValidationError(
          'allocation_mismatch',
          'That allocation belongs to a different batch.',
        );
      }
      if (ctx.role === 'salesperson' && allocation.salesperson_id !== ctx.userId) {
        throw new SyncValidationError(
          'not_your_allocation',
          'Those birds were allocated to another salesperson.',
        );
      }
      const used = await allocationUsed(tx, allocation.id);
      if (used.sold + used.returned + input.count > allocation.count) {
        throw new SyncValidationError(
          'not_enough_allocated',
          `Only ${allocation.count - used.sold - used.returned} birds are left on that allocation.`,
        );
      }
    } else if (ctx.role === 'salesperson') {
      throw new SyncValidationError(
        'allocation_required',
        'Sell from your allocation so the farm can see which birds left with you.',
      );
    }

    const row = await insertOne(tx, 'bird_sales', {
      id,
      farm_id: ctx.farmId,
      batch_id: input.batchId,
      allocation_id: input.allocationId ?? null,
      count: input.count,
      buyer: input.buyer ?? null,
      note: input.note ?? null,
      unit_price_kes: input.unitPriceKes ?? null,
      ...eventColumns(ctx, input),
    });
    if (!row) return null;

    await assertNotNegative(tx, ctx.farmId, input.batchId);
    return { changeSeq: String(row.change_seq) };
  },

  toChange(row) {
    return {
      table: 'bird_sales',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        batchId: row['batch_id'],
        allocationId: row['allocation_id'],
        count: num(row['count']),
        buyer: row['buyer'],
        note: row['note'],
        unitPriceKes: row['unit_price_kes'] === null ? null : num(row['unit_price_kes']),
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const vaccinationEntity: SyncEntity = {
  table: 'vaccination_events',
  schema: vaccinationInputSchema,
  permissionsFor: () => ['record_vaccination'],

  async insert(tx, ctx, id, data) {
    const input = data as VaccinationInput;
    await requireBatch(tx, ctx.farmId, input.batchId);

    const row = await insertOne(tx, 'vaccination_events', {
      id,
      farm_id: ctx.farmId,
      batch_id: input.batchId,
      day: input.day,
      note: input.note ?? null,
      ...eventColumns(ctx, input),
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'vaccination_events',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        batchId: row['batch_id'],
        day: num(row['day']),
        note: row['note'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const stockItemEntity: SyncEntity = {
  table: 'stock_items',
  schema: stockItemInputSchema,
  permissionsFor: () => ['manage_setup', 'receive_stock'],

  async insert(tx, ctx, id, data) {
    const input = data as StockItemInput;
    const row = await insertOne(tx, 'stock_items', {
      id,
      farm_id: ctx.farmId,
      name: input.name,
      category: input.category,
      unit: 'kg',
      reorder_level_kg: input.reorderLevelKg ?? null,
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'stock_items',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        name: row['name'],
        category: row['category'],
        unit: row['unit'],
        reorderLevelKg: row['reorder_level_kg'] === null ? null : num(row['reorder_level_kg']),
        active: row['active'],
      },
    };
  },
};

const stockMovementEntity: SyncEntity = {
  table: 'stock_movements',
  schema: stockMovementInputSchema,
  permissionsFor(data) {
    const kind = (data as { kind?: string }).kind;
    if (kind === 'adjustment') return ['manage_setup'];
    if (kind === 'receipt') return ['receive_stock'];
    return ['reserve_feed', 'record_feeding'];
  },

  async insert(tx, ctx, id, data) {
    const input = data as StockMovementInput;

    const item = await tx.one<{ id: string }>(
      'select id from stock_items where id = $1 and farm_id = $2',
      [input.stockItemId, ctx.farmId],
    );
    if (!item) {
      throw new SyncValidationError(
        'unknown_stock_item',
        'That feed is not on this farm. Refresh and choose it again.',
      );
    }
    if (input.batchId) await requireBatch(tx, ctx.farmId, input.batchId);

    // Feed handed to a salesperson must belong to the same batch as the
    // allocation, or the two records would describe different birds.
    if (input.allocationId) {
      const allocation = await requireAllocation(tx, ctx.farmId, input.allocationId);
      if (allocation.batch_id !== input.batchId) {
        throw new SyncValidationError(
          'allocation_mismatch',
          'That allocation belongs to a different batch.',
        );
      }
    }

    const row = await insertOne(tx, 'stock_movements', {
      id,
      farm_id: ctx.farmId,
      stock_item_id: input.stockItemId,
      kind: input.kind,
      quantity_kg: input.quantityKg,
      unit_cost_kes_per_kg: input.unitCostKesPerKg ?? null,
      batch_id: input.batchId ?? null,
      allocation_id: input.allocationId ?? null,
      note: input.note ?? null,
      ...eventColumns(ctx, input),
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'stock_movements',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        stockItemId: row['stock_item_id'],
        kind: row['kind'],
        quantityKg: num(row['quantity_kg']),
        unitCostKesPerKg:
          row['unit_cost_kes_per_kg'] === null ? null : num(row['unit_cost_kes_per_kg']),
        batchId: row['batch_id'],
        allocationId: row['allocation_id'],
        note: row['note'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const weightEntity: SyncEntity = {
  table: 'batch_weights',
  schema: weightInputSchema,
  permissionsFor: () => ['record_growth'],

  async insert(tx, ctx, id, data) {
    const input = data as WeightInput;
    await requireBatch(tx, ctx.farmId, input.batchId);

    const row = await insertOne(tx, 'batch_weights', {
      id,
      farm_id: ctx.farmId,
      batch_id: input.batchId,
      sample_count: input.sampleCount,
      average_weight_kg: input.averageWeightKg,
      note: input.note ?? null,
      ...eventColumns(ctx, input),
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'batch_weights',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        batchId: row['batch_id'],
        sampleCount: num(row['sample_count']),
        averageWeightKg: num(row['average_weight_kg']),
        note: row['note'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const expenseEntity: SyncEntity = {
  table: 'expenses',
  schema: expenseInputSchema,
  permissionsFor: () => ['record_expense'],
  // The cash book is read-only to the people who run the money. A stock
  // keeper's phone never pulls these rows.
  readPermissions: ['view_finance', 'record_expense'],

  async insert(tx, ctx, id, data) {
    const input = data as ExpenseInput;
    if (input.batchId) await requireBatch(tx, ctx.farmId, input.batchId);

    const row = await insertOne(tx, 'expenses', {
      id,
      farm_id: ctx.farmId,
      category: input.category,
      amount_kes: input.amountKes,
      paid_to: input.paidTo ?? null,
      method: input.method,
      batch_id: input.batchId ?? null,
      note: input.note ?? null,
      ...eventColumns(ctx, input),
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'expenses',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        category: row['category'],
        amountKes: num(row['amount_kes']),
        paidTo: row['paid_to'],
        method: row['method'],
        batchId: row['batch_id'],
        note: row['note'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const expenseApprovalEntity: SyncEntity = {
  table: 'expense_approvals',
  schema: expenseApprovalInputSchema,
  permissionsFor: () => ['approve_expense'],
  readPermissions: ['view_finance', 'record_expense'],

  async insert(tx, ctx, id, data) {
    const input = data as ExpenseApprovalInput;

    const expense = await tx.one<{ id: string }>(
      'select id from expenses where id = $1 and farm_id = $2 and deleted_at is null',
      [input.expenseId, ctx.farmId],
    );
    if (!expense) {
      throw new SyncValidationError(
        'unknown_expense',
        'That expense is not on this farm. Refresh and try again.',
      );
    }

    try {
      const row = await insertOne(tx, 'expense_approvals', {
        id,
        farm_id: ctx.farmId,
        expense_id: input.expenseId,
        decision: input.decision,
        note: input.note ?? null,
        ...eventColumns(ctx, input),
      });
      return row ? { changeSeq: String(row.change_seq) } : null;
    } catch (error) {
      // An expense has one decision. A second, different decision collides with
      // the partial unique index rather than overwriting the first.
      if ((error as { code?: string }).code === '23505') {
        throw new SyncValidationError(
          'already_decided',
          'This expense already has a decision.',
        );
      }
      throw error;
    }
  },

  toChange(row) {
    return {
      table: 'expense_approvals',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        expenseId: row['expense_id'],
        decision: row['decision'],
        note: row['note'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const allocationEntity: SyncEntity = {
  table: 'sales_allocations',
  schema: allocationInputSchema,
  permissionsFor: () => ['allocate_stock'],

  async insert(tx, ctx, id, data) {
    const input = data as AllocationInput;
    const batch = await requireBatch(tx, ctx.farmId, input.batchId);

    const person = await tx.one<{ id: string; role: string }>(
      `select id, role from users
        where id = $1 and farm_id = $2 and deleted_at is null and status = 'active'`,
      [input.salespersonId, ctx.farmId],
    );
    if (!person || person.role !== 'salesperson') {
      throw new SyncValidationError(
        'unknown_salesperson',
        'Choose an active salesperson on this farm.',
      );
    }

    // Never promise more birds than the batch has alive. Allocating does not
    // remove them from the flock; a sale does.
    const live = await liveCount(tx, ctx.farmId, batch.id);
    const outstanding = await batchOutstanding(tx, batch.id);
    if (outstanding + input.count > live) {
      throw new SyncValidationError(
        'not_enough_birds',
        `Only ${Math.max(live - outstanding, 0)} birds are free to allocate from this batch.`,
      );
    }

    const row = await insertOne(tx, 'sales_allocations', {
      id,
      farm_id: ctx.farmId,
      batch_id: input.batchId,
      salesperson_id: input.salespersonId,
      count: input.count,
      note: input.note ?? null,
      ...eventColumns(ctx, input),
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'sales_allocations',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        batchId: row['batch_id'],
        salespersonId: row['salesperson_id'],
        count: num(row['count']),
        note: row['note'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const birdReturnEntity: SyncEntity = {
  table: 'bird_returns',
  schema: birdReturnInputSchema,
  permissionsFor: () => ['record_return'],

  async insert(tx, ctx, id, data) {
    const input = data as BirdReturnInput;
    const allocation = await requireAllocation(tx, ctx.farmId, input.allocationId);

    if (ctx.role === 'salesperson' && allocation.salesperson_id !== ctx.userId) {
      throw new SyncValidationError(
        'not_your_allocation',
        'Those birds were allocated to another salesperson.',
      );
    }

    const used = await allocationUsed(tx, allocation.id);
    if (used.sold + used.returned + input.count > allocation.count) {
      throw new SyncValidationError(
        'not_enough_allocated',
        `Only ${allocation.count - used.sold - used.returned} birds are left on that allocation.`,
      );
    }

    const row = await insertOne(tx, 'bird_returns', {
      id,
      farm_id: ctx.farmId,
      allocation_id: input.allocationId,
      count: input.count,
      reason: input.reason ?? null,
      ...eventColumns(ctx, input),
    });
    return row ? { changeSeq: String(row.change_seq) } : null;
  },

  toChange(row) {
    return {
      table: 'bird_returns',
      id: String(row['id']),
      changeSeq: String(row['change_seq']),
      deletedAt: asIso(row['deleted_at']),
      data: {
        allocationId: row['allocation_id'],
        count: num(row['count']),
        reason: row['reason'],
        recordedAt: asIso(row['recorded_at']),
        recordedBy: row['recorded_by'],
        clientTime: asIso(row['client_time']),
      },
    };
  },
};

const ENTITIES: SyncEntity[] = [
  probeEntity,
  houseEntity,
  batchEntity,
  mortalityEntity,
  transferEntity,
  saleEntity,
  allocationEntity,
  birdReturnEntity,
  vaccinationEntity,
  stockItemEntity,
  stockMovementEntity,
  weightEntity,
  expenseEntity,
  expenseApprovalEntity,
];

export function findEntity(table: string): SyncEntity | undefined {
  return ENTITIES.find((entity) => entity.table === table);
}

export function syncedEntityNames(): string[] {
  return ENTITIES.map((entity) => entity.table);
}

export const entitySchemas = {
  probes: probeSchema,
  houses: houseInputSchema,
  batches: batchInputSchema,
  mortality_events: mortalityInputSchema,
  bird_transfers: transferInputSchema,
  bird_sales: saleInputSchema,
  sales_allocations: allocationInputSchema,
  bird_returns: birdReturnInputSchema,
  vaccination_events: vaccinationInputSchema,
  stock_items: stockItemInputSchema,
  stock_movements: stockMovementInputSchema,
  batch_weights: weightInputSchema,
  expenses: expenseInputSchema,
  expense_approvals: expenseApprovalInputSchema,
} as const;

export type ProbeData = z.infer<typeof probeSchema>;
