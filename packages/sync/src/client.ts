import {
  MAX_PULL_LIMIT,
  MAX_PUSH_RECORDS,
  type SyncChange,
  type SyncPullResponse,
  type SyncPushRecord,
  type SyncPushResponse,
  type SyncRejection,
} from '@farmatics/shared';
import { recordKey, type FarmaticsDb, type LocalRecord, type OutboxEntry } from './db.js';

/**
 * The sync engine.
 *
 * Push then pull, always in that order: a phone's own write is on the server
 * before it asks what changed, so it never mistakes its own record for
 * someone else's.
 *
 * Everything here is transport-agnostic. The app supplies an authenticated
 * transport; the two-phone test supplies one wired straight into the API.
 */

export interface SyncTransport {
  push(records: SyncPushRecord[]): Promise<SyncPushResponse>;
  pull(cursor: string, limit: number): Promise<SyncPullResponse>;
}

export interface PushOutcome {
  attempted: number;
  accepted: number;
  duplicated: number;
  rejected: number;
  /** Sent but not answered - left pending, so nothing is lost. */
  unanswered: number;
}

export interface PullOutcome {
  pulled: number;
  cursor: string;
}

export interface SyncRunResult {
  ok: boolean;
  at: string;
  pushed: PushOutcome;
  pulled: PullOutcome;
  /** Records still waiting to sync after this run. */
  pending: number;
  /** Safe to show the user: no internals, no stack. */
  error?: string;
}

export interface SyncClientOptions {
  db: FarmaticsDb;
  transport: SyncTransport;
  now?: () => Date;
  maxPushRecords?: number;
  pullLimit?: number;
  /** Stops a misbehaving server from keeping the app in a pull loop. */
  maxPullPages?: number;
}

export interface SyncClient {
  /** Saves locally and queues for sync in one atomic write. */
  saveRecord(table: string, id: string, data: Record<string, unknown>): Promise<string>;
  pendingCount(): Promise<number>;
  attention(): Promise<SyncRejection[]>;
  getCursor(): Promise<string>;
  getRecord(table: string, id: string): Promise<LocalRecord | undefined>;
  listRecords(table: string): Promise<LocalRecord[]>;
  push(): Promise<PushOutcome>;
  pull(): Promise<PullOutcome>;
  /** Push then pull, turning failures into a result the UI can render. */
  sync(): Promise<SyncRunResult>;
  /**
   * Fires after a local save, a push or a pull. Screens use it to re-read the
   * phone database instead of polling it.
   */
  subscribe(listener: () => void): () => void;
  /** Repeats `sync` while the app is open. Returns a stop function. */
  startLoop(options: {
    intervalMs?: number;
    onResult?: (result: SyncRunResult) => void;
  }): () => void;
}
const emptyPush = (): PushOutcome => ({
  attempted: 0,
  accepted: 0,
  duplicated: 0,
  rejected: 0,
  unanswered: 0,
});

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const { db, transport } = options;
  const now = options.now ?? (() => new Date());
  const maxPushRecords = Math.min(options.maxPushRecords ?? MAX_PUSH_RECORDS, MAX_PUSH_RECORDS);
  const pullLimit = Math.min(options.pullLimit ?? 100, MAX_PULL_LIMIT);
  const maxPullPages = options.maxPullPages ?? 20;

  /**
   * Change notification. Dexie has no cross-tab change feed that is cheap
   * enough for every table, so the client owns the signal: it knows exactly
   * when it wrote something.
   */
  const listeners = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken screen must not stop the other screens from refreshing.
      }
    }
  }

  async function readCursor(): Promise<string> {
    const entry = await db.meta.get('cursor');
    return entry?.value ?? '0';
  }

  async function saveRecord(
    table: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const key = recordKey(table, id);
    const timestamp = now().toISOString();

    await db.transaction('rw', db.records, db.outbox, db.meta, async () => {
      const sequence = Number((await db.meta.get('outboxSeq'))?.value ?? '0') + 1;
      await db.meta.put({ key: 'outboxSeq', value: String(sequence) });
      await db.records.put({
        key,
        table,
        id,
        data,
        changeSeq: null,
        deletedAt: null,
        dirty: true,
        updatedAt: timestamp,
      });
      await db.outbox.put({
        id: key,
        table,
        recordId: id,
        data,
        createdAt: timestamp,
        order: sequence,
        attempts: 0,
        status: 'pending',
      });
    });

    notify();
    return key;
  }

  async function pendingCount(): Promise<number> {
    return db.outbox.where('status').equals('pending').count();
  }

  async function attention(): Promise<SyncRejection[]> {
    const rows = await db.outbox.where('status').equals('rejected').sortBy('createdAt');
    return rows.map((row) => ({
      id: row.recordId,
      table: row.table,
      reason: row.reason ?? 'rejected',
      message: row.message ?? 'The server could not accept this record.',
    }));
  }

  async function push(): Promise<PushOutcome> {
    const queued = await db.outbox.where('status').equals('pending').sortBy('createdAt');
    // Parents before children: a house before its batch, a stock item before
    // its receipt. Falling back to creation time keeps old rows ordered.
    queued.sort(
      (left, right) =>
        (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt),
    );
    const batch = queued.slice(0, maxPushRecords);
    const outcome = emptyPush();
    if (batch.length === 0) return outcome;

    outcome.attempted = batch.length;

    let response: SyncPushResponse;
    try {
      response = await transport.push(
        batch.map((entry) => ({
          table: entry.table,
          id: entry.recordId,
          data: entry.data,
        })),
      );
    } catch (error) {
      // The records stay pending. Only the attempt counter moves, so the UI
      // can show "tried N times, still offline".
      await db.transaction('rw', db.outbox, async () => {
        for (const entry of batch) {
          await db.outbox.update(entry.id, { attempts: entry.attempts + 1 });
        }
      });
      throw error;
    }

    const results = new Map(
      response.results.map((result) => [recordKey(result.table, result.id), result]),
    );
    const timestamp = now().toISOString();

    await db.transaction('rw', db.outbox, db.records, db.meta, async () => {
      for (const entry of batch) {
        const result = results.get(entry.id);
        if (!result) {
          // No answer for this record: leave it pending rather than assuming.
          outcome.unanswered += 1;
          continue;
        }

        if (result.status === 'rejected') {
          outcome.rejected += 1;
          await db.outbox.update(entry.id, {
            status: 'rejected',
            reason: result.reason ?? 'rejected',
            message: result.message ?? 'The server refused this record.',
            attempts: entry.attempts + 1,
          });
          continue;
        }

        if (result.status === 'duplicate') outcome.duplicated += 1;
        else outcome.accepted += 1;

        await db.outbox.delete(entry.id);
        await db.records.update(entry.id, {
          changeSeq: result.changeSeq ?? null,
          dirty: false,
          updatedAt: timestamp,
        });
      }

      await db.meta.put({ key: 'lastPushAt', value: timestamp });
    });

    notify();
    return outcome;
  }

  async function pull(): Promise<PullOutcome> {
    let cursor = await readCursor();
    let pulled = 0;

    for (let page = 0; page < maxPullPages; page += 1) {
      const response = await transport.pull(cursor, pullLimit);

      await db.transaction('rw', db.records, db.meta, async () => {
        for (const change of response.changes) {
          await applyChange(change);
          pulled += 1;
        }
        await db.meta.put({ key: 'cursor', value: response.cursor });
      });

      cursor = response.cursor;

      // An empty page with hasMore set would otherwise spin forever.
      if (!response.hasMore || response.changes.length === 0) break;
    }

    await db.meta.put({ key: 'lastPullAt', value: now().toISOString() });
    notify();
    return { pulled, cursor };
  }

  async function applyChange(change: SyncChange): Promise<void> {
    const key = recordKey(change.table, change.id);
    const existing = await db.records.get(key);

    await db.records.put({
      key,
      table: change.table,
      id: change.id,
      // A record this phone has not pushed yet keeps its local copy; the
      // server version would otherwise overwrite work that is still queued.
      data: existing?.dirty ? existing.data : change.data,
      changeSeq: change.changeSeq,
      deletedAt: change.deletedAt,
      dirty: existing?.dirty ?? false,
      updatedAt: now().toISOString(),
    });
  }

  let running: Promise<SyncRunResult> | null = null;

  /**
   * The card, the timer and the online listener can all ask at once. One run
   * at a time keeps the same outbox entries from being pushed twice.
   */
  function sync(): Promise<SyncRunResult> {
    if (running) return running;
    running = runSync().finally(() => {
      running = null;
    });
    return running;
  }

  async function runSync(): Promise<SyncRunResult> {
    const at = now().toISOString();
    try {
      const pushed = await push();
      const pulled = await pull();
      const pending = await pendingCount();
      await db.meta.put({ key: 'lastSuccessAt', value: now().toISOString() });
      await db.meta.delete('lastError');
      return { ok: true, at, pushed, pulled, pending };
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Could not reach the server. Your work is saved and will sync later.';
      await db.meta.put({ key: 'lastError', value: message });
      const pending = await pendingCount();
      return {
        ok: false,
        at,
        pushed: emptyPush(),
        pulled: { pulled: 0, cursor: await readCursor() },
        pending,
        error: message,
      };
    }
  }

  function startLoop(config: {
    intervalMs?: number;
    onResult?: (result: SyncRunResult) => void;
  }): () => void {
    const intervalMs = config.intervalMs ?? 30_000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      const result = await sync();
      config.onResult?.(result);
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };

    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return {
    saveRecord,
    pendingCount,
    attention,
    getCursor: readCursor,
    getRecord: (table, id) => db.records.get(recordKey(table, id)),
    listRecords: (table) => db.records.where('table').equals(table).toArray(),
    push,
    pull,
    sync,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    startLoop,
  };
}

export type { OutboxEntry };
