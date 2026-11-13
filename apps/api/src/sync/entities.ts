import type { Db } from '@farmatics/db';
import {
  batchInputSchema,
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
  type BatchInput,
  type ExpenseApprovalInput,
  type ExpenseInput,
  type HouseInput,
  type MortalityInput,
  type Permission,
  type SaleInput,
  type StockItemInput,
  type StockMovementInput,
  type SyncChange,
  type TransferInput,
  type VaccinationInput,
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

    const row = await insertOne(tx, 'bird_sales', {
      id,
      farm_id: ctx.farmId,
      batch_id: input.batchId,
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

    const row = await insertOne(tx, 'stock_movements', {
      id,
      farm_id: ctx.farmId,
      stock_item_id: input.stockItemId,
      kind: input.kind,
      quantity_kg: input.quantityKg,
      batch_id: input.batchId ?? null,
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
        batchId: row['batch_id'],
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

const ENTITIES: SyncEntity[] = [
  probeEntity,
  houseEntity,
  batchEntity,
  mortalityEntity,
  transferEntity,
  saleEntity,
  vaccinationEntity,
  stockItemEntity,
  stockMovementEntity,
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
  vaccination_events: vaccinationInputSchema,
  stock_items: stockItemInputSchema,
  stock_movements: stockMovementInputSchema,
  expenses: expenseInputSchema,
  expense_approvals: expenseApprovalInputSchema,
} as const;

export type ProbeData = z.infer<typeof probeSchema>;
