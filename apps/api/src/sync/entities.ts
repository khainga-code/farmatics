import type { Db } from '@farmatics/db';
import type { SyncChange } from '@farmatics/shared';
import { z } from 'zod';

/**
 * The sync entity registry.
 *
 * Every table that phones may push to is described here: how to validate a
 * record, how to insert it idempotently, and how to render it back for a
 * pull. Adding a real module later means adding one entry, not a new endpoint
 * shape.
 *
 * `probes` is the throwaway entity that proves the mechanics. It carries no
 * business meaning and is removed once poultry, store and sales land.
 */

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

const ENTITIES: SyncEntity[] = [probeEntity];

export function findEntity(table: string): SyncEntity | undefined {
  return ENTITIES.find((entity) => entity.table === table);
}

export function syncedEntityNames(): string[] {
  return ENTITIES.map((entity) => entity.table);
}

export const entitySchemas = {
  probes: probeSchema,
} as const;

export type ProbeData = z.infer<typeof probeSchema>;
