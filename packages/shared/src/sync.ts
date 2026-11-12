/**
 * The wire contract for sync. Kept in shared so the phone and the server
 * cannot disagree about the shape of a push or a pull.
 *
 * `changeSeq` and `cursor` are strings, not numbers: they come from a bigint
 * column and JSON would silently lose precision past 2^53.
 */

import { z } from 'zod';

export const MAX_PUSH_RECORDS = 200;
export const MAX_PULL_LIMIT = 500;

/**
 * The outer shape only. Each record is validated separately so one bad entry
 * is rejected on its own instead of failing the whole offline batch.
 */
export const syncPushRequestSchema = z.object({
  deviceId: z.string().uuid().optional(),
  records: z.array(z.unknown()).min(1).max(MAX_PUSH_RECORDS),
});

export const syncPushRecordSchema = z.object({
  table: z.string().trim().min(1).max(64),
  id: z.string().trim().min(1).max(64),
  data: z.record(z.string(), z.unknown()),
});

export const syncPullQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^\d+$/, 'The cursor is not valid.')
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).optional(),
});

export interface SyncPushRecord {
  table: string;
  /** Created on the phone. Re-sending the same id is what makes a retry safe. */
  id: string;
  data: Record<string, unknown>;
}

export interface SyncPushRequest {
  deviceId?: string;
  records: SyncPushRecord[];
}

export type SyncPushStatus = 'accepted' | 'duplicate' | 'rejected';

export interface SyncPushResult {
  table: string;
  id: string;
  status: SyncPushStatus;
  /** Present when accepted or duplicate. */
  changeSeq?: string;
  /** Present when rejected, e.g. `invalid_record` or `unknown_table`. */
  reason?: string;
  message?: string;
}

export interface SyncPushResponse {
  results: SyncPushResult[];
  serverTime: string;
}

export interface SyncChange {
  table: string;
  id: string;
  changeSeq: string;
  deletedAt: string | null;
  data: Record<string, unknown>;
}

export interface SyncPullResponse {
  changes: SyncChange[];
  /** The cursor to send next time. Never moves backwards. */
  cursor: string;
  hasMore: boolean;
  serverTime: string;
}

/** A record the server refused, surfaced in the app's "needs attention" list. */
export interface SyncRejection {
  id: string;
  table: string;
  reason: string;
  message: string;
}
