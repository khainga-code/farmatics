import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { createPgliteDb } from '../src/pglite-driver.js';
import { splitStatements } from '../src/sql-split.js';

let db: Db;

const farmA = randomUUID();
const farmB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

beforeAll(async () => {
  db = createPgliteDb(':memory:');
  await runMigrations(db);
  await db.query(
    'insert into farms (id, name) values ($1, $2), ($3, $4)',
    [farmA, 'A Farm', farmB, 'B Farm'],
  );
  await db.query(
    `insert into users (id, farm_id, name, phone, role)
     values ($1, $2, 'Owner A', '+254700000001', 'owner'),
            ($3, $4, 'Owner B', '+254700000002', 'owner')`,
    [userA, farmA, userB, farmB],
  );
}, 30_000);

afterAll(async () => {
  await db.close();
});

/** Runs a callback as the restricted runtime role, scoped to one farm. */
async function asTenant<T>(farmId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role farmatics_app');
    await tx.query('select set_config($1, $2, true)', ['app.farm_id', farmId]);
    return fn(tx);
  });
}

describe('row level security', () => {
  it('returns only the current farm rows', async () => {
    const rows = await asTenant(farmA, (tx) =>
      tx.query<{ phone: string }>('select phone from users'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone).toBe('+254700000001');
  });

  it('hides other farms even when the query asks for them by id', async () => {
    const rows = await asTenant(farmA, (tx) =>
      tx.query('select id from users where id = $1', [userB]),
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to let a tenant write into another farm', async () => {
    await expect(
      asTenant(farmA, (tx) =>
        tx.query(
          `insert into users (farm_id, name, phone, role)
           values ($1, 'Injected', '+254700000003', 'owner')`,
          [farmB],
        ),
      ),
    ).rejects.toThrow();
  });

  it('returns no rows at all when no farm context is set', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.exec('set local role farmatics_app');
      return tx.query('select id from users');
    });
    expect(rows).toHaveLength(0);
  });

  it('denies the runtime role access to sessions and one-time codes', async () => {
    await expect(
      asTenant(farmA, (tx) => tx.query('select * from otp_codes')),
    ).resolves.toHaveLength(0);
  });
});

describe('change sequence', () => {
  it('increases monotonically per write so a pull cursor cannot miss rows', async () => {
    const before = await db.one<{ seq: string }>(
      "select coalesce(max(change_seq), 0)::text as seq from users",
    );
    const start = BigInt(before?.seq ?? '0');

    await db.query(
      `insert into users (farm_id, name, phone, role)
       values ($1, 'Extra', '+254700000010', 'stock_keeper')`,
      [farmA],
    );
    await db.query(
      `insert into users (farm_id, name, phone, role)
       values ($1, 'Extra 2', '+254700000011', 'stock_keeper')`,
      [farmA],
    );

    const rows = await db.query<{ change_seq: string; phone: string }>(
      'select change_seq, phone from users where change_seq > $1 order by change_seq',
      [start.toString()],
    );
    expect(rows).toHaveLength(2);
    expect(BigInt(rows[1]!.change_seq)).toBeGreaterThan(BigInt(rows[0]!.change_seq));
  });

  it('stamps updated_at on update but leaves created_at alone', async () => {
    const created = await db.one<{ created_at: string; updated_at: string }>(
      'select created_at, updated_at from users where id = $1',
      [userA],
    );
    await new Promise((r) => setTimeout(r, 10));
    await db.query('update users set name = $2 where id = $1', [userA, 'Renamed']);

    const after = await db.one<{ created_at: string; updated_at: string }>(
      'select created_at, updated_at from users where id = $1',
      [userA],
    );
    expect(new Date(after!.created_at).getTime()).toBe(
      new Date(created!.created_at).getTime(),
    );
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(created!.updated_at).getTime(),
    );
  });
});

describe('splitStatements', () => {
  it('keeps dollar quoted function bodies in one piece', () => {
    const sql = `
      create function a() returns void language plpgsql as $$
      begin
        raise notice 'one; two';
      end
      $$;
      select 1;
    `;
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it('ignores semicolons in comments and string literals', () => {
    const sql = `select ';' as a; -- trailing ; comment\nselect "we;ird" from t;`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("select ';' as a");
  });
});
