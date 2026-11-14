import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgliteDb,
  runMigrations,
  type DatabaseContext,
  type Db,
} from '@farmatics/db';
import {
  DAY_MS,
  type TokenBundle,
  type SyncChange,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@farmatics/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SmsSender } from '../src/auth/sms.js';

/**
 * What a phone is allowed to pull.
 *
 * The cash book is not for every member of staff. A stock keeper or a
 * salesperson must not receive expense rows at all, not merely fail to open
 * the screen; the farm's birds, feed and sales stay visible.
 */

let app: FastifyInstance;
let db: Db;
let ctx: DatabaseContext;
let phoneCounter = 0;

const sms: SmsSender = { send: async () => {} };

beforeAll(async () => {
  db = createPgliteDb(':memory:');
  await runMigrations(db);
  ctx = { app: db, admin: db, driver: 'embedded', close: async () => {} };
  app = await buildApp({
    config: loadConfig({
      rateLimitEnabled: false,
      exposeOtpInResponse: true,
      jwtSecret: 'test-secret-that-is-long-enough-for-hashing',
      accessTokenTtlSeconds: 900,
    }),
    db: ctx,
    logger: false,
    sms,
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function nextPhone(): string {
  phoneCounter += 1;
  return `0740${String(phoneCounter).padStart(6, '0')}`;
}

function dayOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function registerFarm(): Promise<TokenBundle> {
  const phone = nextPhone();
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      farmName: `Farm ${phone}`,
      ownerName: 'Owner',
      phone,
      password: 'farmatics2026',
    },
  });
  expect(registered.statusCode).toBe(201);
  const { devCode } = registered.json() as { devCode: string };

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    payload: { phone, code: devCode, deviceLabel: 'test phone' },
  });
  expect(verified.statusCode).toBe(201);
  return verified.json() as TokenBundle;
}

async function createEmployee(owner: TokenBundle, role: string): Promise<TokenBundle> {
  const username = `worker${phoneCounter}${randomUUID().slice(0, 4)}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/employees',
    headers: auth(owner.accessToken),
    payload: { name: 'Worker', phone: nextPhone(), username, role },
  });
  expect(created.statusCode).toBe(201);
  const { tempPin } = created.json() as { tempPin: string };

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/staff-login',
    payload: { username, pin: tempPin, deviceLabel: 'staff phone' },
  });
  expect(login.statusCode).toBe(200);
  return login.json() as TokenBundle;
}

async function push(bundle: TokenBundle, records: SyncPushRequest['records']) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: auth(bundle.accessToken),
    payload: { deviceId: bundle.deviceId, records },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SyncPushResponse;
}

async function pull(bundle: TokenBundle): Promise<SyncChange[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/sync/pull?cursor=0&limit=500',
    headers: auth(bundle.accessToken),
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { changes: SyncChange[] }).changes;
}

/** A house, a batch and a sellable sale, so the pull has non-finance rows. */
async function seedFarmData(owner: TokenBundle) {
  const houseId = randomUUID();
  const batchId = randomUUID();
  const saleId = randomUUID();

  const pushed = await push(owner, [
    { table: 'houses', id: houseId, data: { name: 'House 1' } },
    {
      table: 'batches',
      id: batchId,
      data: {
        houseId,
        code: `B-${batchId.slice(0, 6)}`,
        arrivalDate: dayOnly(new Date(Date.now() - 30 * DAY_MS)),
        initialCount: 500,
      },
    },
    {
      table: 'bird_sales',
      id: saleId,
      data: {
        batchId,
        count: 10,
        unitPriceKes: 550,
        recordedAt: new Date().toISOString(),
      },
    },
  ]);
  expect(pushed.results.map((result) => result.status)).toEqual([
    'accepted',
    'accepted',
    'accepted',
  ]);

  return { houseId, batchId, saleId };
}

async function recordExpense(owner: TokenBundle): Promise<string> {
  const id = randomUUID();
  const response = await push(owner, [
    {
      table: 'expenses',
      id,
      data: {
        category: 'transport',
        amountKes: 1500,
        method: 'cash',
        recordedAt: new Date().toISOString(),
      },
    },
  ]);
  expect(response.results[0]?.status).toBe('accepted');
  return id;
}

function tableNames(changes: SyncChange[]): string[] {
  return [...new Set(changes.map((change) => change.table))].sort();
}

describe('who pulls the cash book', () => {
  it('sends expenses to the owner and not to a stock keeper', async () => {
    const owner = await registerFarm();
    const keeper = await createEmployee(owner, 'stock_keeper');
    const { batchId } = await seedFarmData(owner);
    await recordExpense(owner);

    const keeperTables = tableNames(await pull(keeper));
    expect(keeperTables).toContain('houses');
    expect(keeperTables).toContain('batches');
    expect(keeperTables).toContain('bird_sales');
    expect(keeperTables).not.toContain('expenses');
    expect(keeperTables).not.toContain('expense_approvals');
    expect(batchId).toBeTruthy();

    const ownerTables = tableNames(await pull(owner));
    expect(ownerTables).toContain('expenses');
  });

  it('keeps sale prices visible because bird counts drive balances', async () => {
    const owner = await registerFarm();
    const keeper = await createEmployee(owner, 'stock_keeper');
    const { saleId } = await seedFarmData(owner);

    const keeperSales = (await pull(keeper)).filter(
      (change) => change.table === 'bird_sales' && change.id === saleId,
    );
    expect(keeperSales).toHaveLength(1);
    expect(keeperSales[0]?.data).toMatchObject({ count: 10, unitPriceKes: 550 });
  });

  it('sends finance to a farm manager, who records and approves expenses', async () => {
    const owner = await registerFarm();
    const manager = await createEmployee(owner, 'farm_manager');
    await seedFarmData(owner);
    await recordExpense(owner);

    expect(tableNames(await pull(manager))).toContain('expenses');
  });

  it('gives a salesperson birds and sales but no cash book', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    await seedFarmData(owner);
    await recordExpense(owner);

    const tables = tableNames(await pull(salesperson));
    expect(tables).toEqual(expect.arrayContaining(['batches', 'bird_sales']));
    expect(tables).not.toContain('expenses');
  });
});
