import type { DatabaseContext, Db } from '@farmatics/db';
import { withTenant } from '@farmatics/db';
import {
  MAX_PULL_LIMIT,
  MAX_PUSH_RECORDS,
  syncPushRecordSchema,
  type SyncChange,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncPushResult,
} from '@farmatics/shared';
import type { AccessClaims } from '../auth/tokens.js';
import { badRequest } from '../errors.js';
import { findEntity, SyncValidationError, syncedEntityNames } from './entities.js';

/**
 * Push and pull.
 *
 * The invariants that matter:
 *   1. The id comes from the phone, so a retry can never double-count.
 *   2. Every write is scoped to the farm in the caller's token, never to a
 *      farm supplied in the payload.
 *   3. A pull returns every change after the cursor in change_seq order, and
 *      the cursor only ever moves forward.
 */

export interface SyncService {
  push(claims: AccessClaims, records: unknown[]): Promise<SyncPushResponse>;
  pull(claims: AccessClaims, cursor: string, limit: number): Promise<SyncPullResponse>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createSyncService(deps: { db: DatabaseContext }): SyncService {
  const { app } = deps.db;

  async function noteDevice(
    tx: Db,
    claims: AccessClaims,
    update: { push?: boolean; cursor?: string | null },
  ): Promise<void> {
    // The device is attached to the access token. Older tokens may not have
    // one, so this is best-effort bookkeeping rather than a requirement.
    const deviceId = claims.dev;
    if (!deviceId) return;

    const cursor = update.cursor ?? null;

    await tx.query(
      `insert into device_sync_state
         (device_id, farm_id, last_pull_seq, last_push_at, updated_at)
       values ($1, $2, coalesce($3::bigint, 0), case when $4 then now() else null end, now())
       on conflict (device_id) do update
         set last_pull_seq = greatest(
               device_sync_state.last_pull_seq,
               coalesce($3::bigint, device_sync_state.last_pull_seq)
             ),
             last_push_at = case
               when $4 then now()
               else device_sync_state.last_push_at
             end,
             updated_at = now()`,
      [deviceId, claims.farm, cursor, update.push === true],
    );
  }

  return {
    async push(claims, records) {
      if (records.length === 0) {
        throw badRequest('empty_push', 'Send at least one record.');
      }
      if (records.length > MAX_PUSH_RECORDS) {
        throw badRequest(
          'push_too_large',
          `Send at most ${MAX_PUSH_RECORDS} records at a time.`,
        );
      }

      const results: SyncPushResult[] = [];

      for (const raw of records) {
        const shape = syncPushRecordSchema.safeParse(raw);
        if (!shape.success) {
          const loose = (raw ?? {}) as { table?: unknown; id?: unknown };
          results.push({
            table: typeof loose.table === 'string' ? loose.table : 'unknown',
            id: typeof loose.id === 'string' ? loose.id : '',
            status: 'rejected',
            reason: 'invalid_record',
            message: 'The record is missing its type, id or data.',
          });
          continue;
        }

        const record = shape.data;
        const entity = findEntity(record.table);
        if (!entity) {
          results.push({
            table: record.table,
            id: record.id,
            status: 'rejected',
            reason: 'unknown_table',
            message: 'This version of the app sent a record type the server does not know.',
          });
          continue;
        }

        if (!UUID.test(record.id)) {
          results.push({
            table: record.table,
            id: record.id,
            status: 'rejected',
            reason: 'invalid_id',
            message: 'The record id is not valid.',
          });
          continue;
        }

        const parsed = entity.schema.safeParse(record.data);
        if (!parsed.success) {
          results.push({
            table: record.table,
            id: record.id,
            status: 'rejected',
            reason: 'invalid_record',
            message: parsed.error.issues[0]?.message ?? 'The record is not valid.',
          });
          continue;
        }

        // The phone's copy of the permissions is a convenience. This is the
        // check that actually decides whether the write happens. An entity
        // with no permission list is available to every signed-in member.
        const allowed = entity.permissionsFor(parsed.data);
        if (allowed.length > 0 && !allowed.some((permission) => claims.perms.includes(permission))) {
          results.push({
            table: record.table,
            id: record.id,
            status: 'rejected',
            reason: 'forbidden',
            message: 'You do not have permission to record this.',
          });
          continue;
        }

        try {
          const outcome = await withTenant(app, claims.farm, async (tx) => {
            const inserted = await entity.insert(
              tx,
              {
                farmId: claims.farm,
                userId: claims.sub,
                deviceId: claims.dev,
                now: new Date(),
              },
              record.id,
              parsed.data,
            );
            if (inserted) return { status: 'accepted' as const, changeSeq: inserted.changeSeq };

            // Nothing inserted: either this phone already sent the record, or
            // another farm owns that id. A lookup inside the tenant tells the
            // two apart without ever reading across the farm boundary.
            const existing = await tx.one<{ change_seq: string }>(
              `select change_seq from ${entity.table}
                where id = $1 and farm_id = $2`,
              [record.id, claims.farm],
            );

            return existing
              ? { status: 'duplicate' as const, changeSeq: String(existing.change_seq) }
              : { status: 'rejected' as const };
          });

          if (outcome.status === 'rejected') {
            results.push({
              table: record.table,
              id: record.id,
              status: 'rejected',
              reason: 'id_conflict',
              message: 'That record id is already in use. Ask the farm owner to check it.',
            });
          } else {
            results.push({
              table: record.table,
              id: record.id,
              status: outcome.status,
              changeSeq: outcome.changeSeq,
            });
          }
        } catch (error) {
          if (error instanceof SyncValidationError) {
            results.push({
              table: record.table,
              id: record.id,
              status: 'rejected',
              reason: error.reason,
              message: error.message,
            });
            continue;
          }

          // A unique violation can still surface if the conflict target and
          // the insert race; anything else is a genuine failure worth
          // reporting per-record so the rest of the batch still lands.
          const code = (error as { code?: string }).code;
          results.push({
            table: record.table,
            id: record.id,
            status: 'rejected',
            reason: code === '23505' ? 'id_conflict' : 'server_error',
            message:
              code === '23505'
                ? 'That record id is already in use.'
                : 'The server could not save this record. It will retry.',
          });
        }
      }

      await withTenant(app, claims.farm, (tx) => noteDevice(tx, claims, { push: true })).catch(
        () => {
          // Sync bookkeeping must never fail an otherwise good push.
        },
      );

      return { results, serverTime: new Date().toISOString() };
    },

    async pull(claims, cursor, limit) {
      if (!/^\d+$/.test(cursor)) {
        throw badRequest('invalid_cursor', 'The sync cursor is not valid.');
      }

      const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_PULL_LIMIT);
      const after = BigInt(cursor);

      const changes = await withTenant(app, claims.farm, async (tx) => {
        const collected: SyncChange[] = [];

        for (const table of syncedEntityNames()) {
          const entity = findEntity(table)!;
          const rows = await tx.query<Record<string, unknown>>(
            `select * from ${table}
              where farm_id = $1 and change_seq > $2
              order by change_seq asc
              limit $3`,
            [claims.farm, after.toString(), bounded + 1],
          );
          collected.push(...rows.map((row) => entity.toChange(row)));
        }

        collected.sort((a, b) => (BigInt(a.changeSeq) < BigInt(b.changeSeq) ? -1 : 1));
        return collected;
      });

      const hasMore = changes.length > bounded;
      const page = hasMore ? changes.slice(0, bounded) : changes;
      const last = page[page.length - 1];

      // Never move backwards: an empty page leaves the cursor where it was.
      const nextCursor = last ? last.changeSeq : cursor;

      await withTenant(app, claims.farm, (tx) =>
        noteDevice(tx, claims, { cursor: nextCursor }),
      ).catch(() => {
        // Bookkeeping only.
      });

      return {
        changes: page,
        cursor: nextCursor,
        hasMore,
        serverTime: new Date().toISOString(),
      };
    },
  };
}

export { asIso };
