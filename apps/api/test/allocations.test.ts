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
 * Salesperson allocation over the real sync endpoints.
 *
 * The rules under test: a salesperson sells only from birds the farm gave
 * them, may not sell more than that, may hand unsold birds back, and cannot
 * touch another salesperson's allocation. The owner and farm manager keep
 * their walk-in sales.
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
  return `0760${String(phoneCounter).padStart(6, '0')}`;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
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
  const username = `worker${randomUUID().slice(0, 8)}`;
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

async function setupBatch(
  owner: TokenBundle,
  options: { arrivalDaysAgo?: number; initialCount?: number; code?: string } = {},
) {
  const houseId = randomUUID();
  const batchId = randomUUID();
  const response = await push(owner, [
    { table: 'houses', id: houseId, data: { name: 'House 1' } },
    {
      table: 'batches',
      id: batchId,
      data: {
        houseId,
        code: options.code ?? `B-${batchId.slice(0, 6)}`,
        arrivalDate: dayOnly(daysAgo(options.arrivalDaysAgo ?? 30)),
        initialCount: options.initialCount ?? 500,
      },
    },
  ]);
  expect(response.results.map((result) => result.status)).toEqual(['accepted', 'accepted']);
  return { houseId, batchId, initialCount: options.initialCount ?? 500 };
}

async function allocate(
  actor: TokenBundle,
  batchId: string,
  salespersonId: string,
  count: number,
) {
  const id = randomUUID();
  const response = await push(actor, [
    {
      table: 'sales_allocations',
      id,
      data: {
        batchId,
        salespersonId,
        count,
        recordedAt: new Date().toISOString(),
      },
    },
  ]);
  return { id, result: response.results[0] };
}

describe('salesperson allocation', () => {
  it('allocates birds to a salesperson and pulls the wire shape', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner);

    const { id, result } = await allocate(owner, batchId, salesperson.user.id, 60);
    expect(result?.status).toBe('accepted');

    const changes = await pull(owner);
    const allocation = changes.find(
      (change) => change.table === 'sales_allocations' && change.id === id,
    );
    expect(allocation?.data).toMatchObject({
      batchId,
      salespersonId: salesperson.user.id,
      count: 60,
    });
  });

  it('refuses an allocation from a salesperson and to a non-salesperson', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const keeper = await createEmployee(owner, 'stock_keeper');
    const { batchId } = await setupBatch(owner);

    const notAllowed = await allocate(owner, batchId, salesperson.user.id, 5);
    expect(notAllowed.result?.status).toBe('accepted');

    const bySalesperson = await allocate(salesperson, batchId, salesperson.user.id, 5);
    expect(bySalesperson.result).toMatchObject({ status: 'rejected', reason: 'forbidden' });

    const toKeeper = await allocate(owner, batchId, keeper.user.id, 5);
    expect(toKeeper.result).toMatchObject({
      status: 'rejected',
      reason: 'unknown_salesperson',
    });
  });

  it('never allocates more birds than the batch has alive', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner, { initialCount: 10 });

    const first = await allocate(owner, batchId, salesperson.user.id, 8);
    expect(first.result?.status).toBe('accepted');

    const second = await allocate(owner, batchId, salesperson.user.id, 5);
    expect(second.result).toMatchObject({ status: 'rejected', reason: 'not_enough_birds' });
  });

  it('lets a salesperson sell from their own allocation', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner);
    const { id: allocationId } = await allocate(owner, batchId, salesperson.user.id, 20);

    const saleId = randomUUID();
    const response = await push(salesperson, [
      {
        table: 'bird_sales',
        id: saleId,
        data: {
          batchId,
          allocationId,
          count: 6,
          buyer: 'Mama Njeri',
          unitPriceKes: 550,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]?.status).toBe('accepted');

    const changes = await pull(owner);
    const sale = changes.find((change) => change.table === 'bird_sales' && change.id === saleId);
    expect(sale?.data).toMatchObject({ allocationId, count: 6, unitPriceKes: 550 });
  });

  it('keeps walk-in sales for the owner but refuses one from a salesperson', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner);

    const walkIn = await push(salesperson, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: { batchId, count: 2, recordedAt: new Date().toISOString() },
      },
    ]);
    expect(walkIn.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'allocation_required',
    });

    const ownerSale = await push(owner, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: { batchId, count: 2, recordedAt: new Date().toISOString() },
      },
    ]);
    expect(ownerSale.results[0]?.status).toBe('accepted');
  });

  it('refuses to sell from another salesperson’s allocation', async () => {
    const owner = await registerFarm();
    const first = await createEmployee(owner, 'salesperson');
    const second = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner);
    const { id: allocationId } = await allocate(owner, batchId, first.user.id, 20);

    const response = await push(second, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId,
          allocationId,
          count: 1,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'not_your_allocation',
    });
  });

  it('refuses to oversell an allocation', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner);
    const { id: allocationId } = await allocate(owner, batchId, salesperson.user.id, 5);

    const response = await push(salesperson, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId,
          allocationId,
          count: 6,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'not_enough_allocated',
    });
  });

  it('returns unsold birds and refuses to return more than is left', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner);
    const { id: allocationId } = await allocate(owner, batchId, salesperson.user.id, 10);

    const sale = await push(salesperson, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId,
          allocationId,
          count: 4,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(sale.results[0]?.status).toBe('accepted');

    const returned = await push(salesperson, [
      {
        table: 'bird_returns',
        id: randomUUID(),
        data: {
          allocationId,
          count: 3,
          reason: 'Market closed',
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(returned.results[0]?.status).toBe('accepted');

    const tooMany = await push(salesperson, [
      {
        table: 'bird_returns',
        id: randomUUID(),
        data: {
          allocationId,
          count: 4,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(tooMany.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'not_enough_allocated',
    });

    const changes = await pull(owner);
    const returns = changes.filter((change) => change.table === 'bird_returns');
    expect(returns).toHaveLength(1);
    expect(returns[0]?.data).toMatchObject({ allocationId, count: 3 });
  });

  it('refuses an allocation from another farm and a mismatched batch', async () => {
    const ownerA = await registerFarm();
    const salespersonA = await createEmployee(ownerA, 'salesperson');
    const batchA = await setupBatch(ownerA, { code: 'B-A' });
    const otherBatchA = await setupBatch(ownerA, { code: 'B-A2' });
    const { id: allocationA } = await allocate(
      ownerA,
      batchA.batchId,
      salespersonA.user.id,
      20,
    );

    const ownerB = await registerFarm();
    const batchB = await setupBatch(ownerB, { code: 'B-B' });

    const crossFarm = await push(ownerB, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId: batchB.batchId,
          allocationId: allocationA,
          count: 1,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(crossFarm.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'unknown_allocation',
    });

    const mismatch = await push(ownerA, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId: otherBatchA.batchId,
          allocationId: allocationA,
          count: 1,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(mismatch.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'allocation_mismatch',
    });
  });

  it('hands feed over with the birds and refuses a mismatched batch', async () => {
    const owner = await registerFarm();
    const salesperson = await createEmployee(owner, 'salesperson');
    const { batchId } = await setupBatch(owner);
    const other = await setupBatch(owner, { code: 'B-OTHER' });
    const { id: allocationId } = await allocate(owner, batchId, salesperson.user.id, 30);

    const stockItemId = randomUUID();
    const item = await push(owner, [
      { table: 'stock_items', id: stockItemId, data: { name: 'Grower mash' } },
    ]);
    expect(item.results[0]?.status).toBe('accepted');

    const feedId = randomUUID();
    const issued = await push(owner, [
      {
        table: 'stock_movements',
        id: feedId,
        data: {
          stockItemId,
          kind: 'issue',
          quantityKg: 50,
          batchId,
          allocationId,
          note: 'Sent with the birds',
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(issued.results[0]?.status).toBe('accepted');

    const changes = await pull(owner);
    const feed = changes.find(
      (change) => change.table === 'stock_movements' && change.id === feedId,
    );
    expect(feed?.data).toMatchObject({ allocationId, batchId, quantityKg: 50 });

    // The allocation names one batch; feed for another batch cannot ride on it.
    const mismatch = await push(owner, [
      {
        table: 'stock_movements',
        id: randomUUID(),
        data: {
          stockItemId,
          kind: 'issue',
          quantityKg: 5,
          batchId: other.batchId,
          allocationId,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(mismatch.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'allocation_mismatch',
    });
  });
});
