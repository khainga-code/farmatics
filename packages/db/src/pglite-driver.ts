import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Db } from './client.js';
import { splitStatements } from './sql-split.js';

type PgliteLike = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
};

/**
 * Embedded Postgres (WASM) for development and tests. It is a real Postgres,
 * so row level security, sequences, plpgsql and advisory locks behave the same
 * as they will in production. Pass ':memory:' for a throwaway database.
 */
export function createPgliteDb(dataDir = ':memory:'): Db {
  const inMemory = dataDir === ':memory:';
  // PGlite creates the data directory with a non-recursive mkdir.
  if (!inMemory) mkdirSync(dataDir, { recursive: true });

  const pg = new PGlite(inMemory ? 'memory://' : dataDir) as unknown as PgliteLike;

  const ready = (async () => {
    // PGlite starts lazily; the first query would otherwise race the open.
    await (pg as unknown as { waitReady?: Promise<void> }).waitReady;
  })();

  function wrap(target: PgliteLike, isRoot: boolean): Db {
    const db: Db = {
      async query<T>(text: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
        await ready;
        const result = await target.query<T>(text, params as unknown[]);
        return result.rows;
      },
      async one<T>(text: string, params: ReadonlyArray<unknown> = []): Promise<T | null> {
        const rows = await db.query<T>(text, params);
        return rows[0] ?? null;
      },
      async exec(text: string): Promise<void> {
        await ready;
        for (const statement of splitStatements(text)) {
          await target.exec(statement);
        }
      },
      async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        await ready;
        return target.transaction(async (tx) => fn(wrap(tx, false)));
      },
      async close(): Promise<void> {
        if (isRoot) await (pg as unknown as { close(): Promise<void> }).close();
      },
    };
    return db;
  }

  return wrap(pg, true);
}
