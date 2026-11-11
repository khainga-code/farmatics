/**
 * The one database shape the whole API codes against.
 *
 * Two drivers implement it: embedded Postgres for development and tests, and
 * the postgres wire driver for deployment. Keeping the surface this small is
 * what makes that swap cheap.
 */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<T[]>;

  one<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<T | null>;

  /** Runs several statements. No parameters. Used by migrations only. */
  exec(sql: string): Promise<void>;

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

export async function setFarmContext(db: Db, farmId: string): Promise<void> {
  // is_local = true, so the setting dies with the transaction.
  await db.query('select set_config($1, $2, true)', ['app.farm_id', farmId]);
}

/**
 * Runs `fn` in a transaction with the tenant already set. Every business query
 * must go through this, or row level security will return nothing.
 */
export async function withTenant<T>(
  db: Db,
  farmId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setFarmContext(tx, farmId);
    return fn(tx);
  });
}
