import postgres from 'postgres';
import type { Db } from './client.js';
import { splitStatements } from './sql-split.js';

/**
 * The slice of the postgres.js API we use. Declared here so the rest of the
 * codebase never depends on its extensive generics.
 */
interface RawSql {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  begin<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
}

/**
 * Standard Postgres driver. Used in deployment against Neon (or any Postgres).
 * `DATABASE_URL` must point at the RLS-restricted role for request handling.
 */
export function createPgDb(url: string, options: { max?: number } = {}): Db {
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
  }) as unknown as RawSql;

  function wrap(target: RawSql, isRoot: boolean): Db {
    const db: Db = {
      async query<T>(text: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
        const rows = await target.unsafe(text, [...params]);
        return rows as T[];
      },

      async one<T>(text: string, params: ReadonlyArray<unknown> = []): Promise<T | null> {
        const rows = await db.query<T>(text, params);
        return rows[0] ?? null;
      },

      async exec(text: string): Promise<void> {
        for (const statement of splitStatements(text)) {
          await target.unsafe(statement);
        }
      },

      async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        // postgres.js has no nested transactions through this wrapper; a
        // nested call simply stays inside the current one.
        if (!isRoot) return fn(db);
        return sql.begin(async (tx) => fn(wrap(tx as RawSql, false)));
      },

      async close(): Promise<void> {
        if (isRoot) await sql.end({ timeout: 5 });
      },
    };
    return db;
  }

  return wrap(sql, true);
}
