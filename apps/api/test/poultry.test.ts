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
  batchCounts,
  DAY_MS,
  saleOpensOn,
  stockOnHand,
  type TokenBundle,
  type SyncChange,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@farmatics/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SmsSender } from '../src/auth/sms.js';

/**
 * Poultry and feed over the real sync endpoints.
 *
 * The rules under test are the farm's: day 1 is arrival, sale opens on day 22,
 * vaccinations on days 12 and 21, feed is measured in kilograms, and a worker
 * cannot record more deaths or sales than there are birds.
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

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function dayOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function registerFarm() {
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

async function createEmployee(
  owner: TokenBundle,
  role: 'stock_keeper' | 'salesperson',
  name: string,
): Promise<TokenBundle> {
  const phone = nextPhone();
  const username = `staff${phoneCounter}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/employees',
    headers: auth(owner.accessToken),
    payload: { name, phone, username, role },
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

async function createStockKeeper(owner: TokenBundle) {
  return createEmployee(owner, 'stock_keeper', 'Joseph Mwangi');
}

async function createSalesperson(owner: TokenBundle) {
  return createEmployee(owner, 'salesperson', 'Mary Wanjiku');
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

/** A house and one batch, pushed by the owner (the only role with setup). */
async function setupBatch(
  owner: TokenBundle,
  options: { arrivalDaysAgo?: number; initialCount?: number; code?: string } = {},
) {
  const houseId = randomUUID();
  const batchId = randomUUID();
  const arrival = daysAgo(options.arrivalDaysAgo ?? 10);

  const response = await push(owner, [
    { table: 'houses', id: houseId, data: { name: 'House 1' } },
    {
      table: 'batches',
      id: batchId,
      data: {
        houseId,
        code: options.code ?? `B-${batchId.slice(0, 6)}`,
        breed: 'Ross 308',
        arrivalDate: dayOnly(arrival),
        initialCount: options.initialCount ?? 500,
      },
    },
  ]);

  expect(response.results.map((result) => result.status)).toEqual(['accepted', 'accepted']);
  return { houseId, batchId, arrival, initialCount: options.initialCount ?? 500 };
}

async function setupStockItem(owner: TokenBundle, name = 'Growers mash') {
  const itemId = randomUUID();
  const response = await push(owner, [
    { table: 'stock_items', id: itemId, data: { name, category: 'feed' } },
  ]);
  expect(response.results[0]?.status).toBe('accepted');
  return itemId;
}

describe('poultry batches', () => {
  it('creates a house and a batch, and pulls them back in wire shape', async () => {
    const owner = await registerFarm();
    const { houseId, batchId, initialCount } = await setupBatch(owner, {
      arrivalDaysAgo: 10,
      code: 'B-001',
    });

    const changes = await pull(owner);
    const house = changes.find((change) => change.table === 'houses' && change.id === houseId);
    const batch = changes.find((change) => change.table === 'batches' && change.id === batchId);

    expect(house?.data['name']).toBe('House 1');
    expect(batch?.data).toMatchObject({
      houseId,
      code: 'B-001',
      breed: 'Ross 308',
      initialCount,
      status: 'active',
    });
    expect(typeof batch?.data['arrivalDate']).toBe('string');
  });

  it('refuses a batch from a worker without setup permission', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const { houseId } = await setupBatch(owner);

    const response = await push(keeper, [
      {
        table: 'batches',
        id: randomUUID(),
        data: {
          houseId,
          code: 'STAFF-1',
          arrivalDate: dayOnly(new Date()),
          initialCount: 100,
        },
      },
    ]);

    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });

  it('rejects a second batch with the same code', async () => {
    const owner = await registerFarm();
    const { houseId } = await setupBatch(owner, { code: 'B-DUP' });

    const response = await push(owner, [
      {
        table: 'batches',
        id: randomUUID(),
        data: {
          houseId,
          code: 'b-dup',
          arrivalDate: dayOnly(new Date()),
          initialCount: 50,
        },
      },
    ]);

    expect(response.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'duplicate_batch_code',
    });
  });
});

describe('daily records', () => {
  it('accepts mortality from a stock keeper and refuses more deaths than birds', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const { batchId } = await setupBatch(owner, { initialCount: 10 });

    const ok = await push(keeper, [
      {
        table: 'mortality_events',
        id: randomUUID(),
        data: { batchId, count: 3, cause: 'Heat', recordedAt: new Date().toISOString() },
      },
    ]);
    expect(ok.results[0]?.status).toBe('accepted');

    const tooMany = await push(keeper, [
      {
        table: 'mortality_events',
        id: randomUUID(),
        data: { batchId, count: 8, recordedAt: new Date().toISOString() },
      },
    ]);
    expect(tooMany.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'not_enough_birds',
    });
  });

  it('reports a retried mortality record as a duplicate, not a second death', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const { batchId } = await setupBatch(owner);
    const record = {
      table: 'mortality_events',
      id: randomUUID(),
      data: { batchId, count: 2, recordedAt: new Date().toISOString() },
    };

    const first = await push(keeper, [record]);
    const second = await push(keeper, [record]);

    expect(first.results[0]?.status).toBe('accepted');
    expect(second.results[0]?.status).toBe('duplicate');
    expect(second.results[0]?.changeSeq).toBe(first.results[0]?.changeSeq);

    const rows = await db.query<{ count: number }>(
      'select count from mortality_events where id = $1',
      [record.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
  });

  it('sells only from day 22', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const young = await setupBatch(owner, { arrivalDaysAgo: 10, code: 'B-YOUNG' });
    const ready = await setupBatch(owner, { arrivalDaysAgo: 22, code: 'B-READY' });

    // Stock keepers record house work, not sales.
    const notAllowed = await push(keeper, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId: ready.batchId,
          count: 5,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(notAllowed.results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });

    const early = await push(owner, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId: young.batchId,
          count: 10,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(early.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'sale_too_early',
    });

    const onTime = await push(owner, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId: ready.batchId,
          count: 10,
          buyer: 'Mama Njeri',
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(onTime.results[0]?.status).toBe('accepted');

    // The gate is a date, not "today": a sale recorded before day 22 fails
    // even if it is pushed later.
    const backdated = await push(owner, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId: ready.batchId,
          count: 1,
          recordedAt: new Date(`${saleOpensOn(dayOnly(ready.arrival))}T12:00:00.000Z`).toISOString(),
        },
      },
    ]);
    expect(backdated.results[0]?.status).toBe('accepted');

    const tooEarlyOnThatDay = await push(owner, [
      {
        table: 'bird_sales',
        id: randomUUID(),
        data: {
          batchId: ready.batchId,
          count: 1,
          recordedAt: new Date(`${dayOnly(daysAgo(23))}T12:00:00.000Z`).toISOString(),
        },
      },
    ]);
    expect(tooEarlyOnThatDay.results[0]?.status).toBe('rejected');
  });

  it('moves birds between batches and keeps both balances derived', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const from = await setupBatch(owner, { initialCount: 500, code: 'B-FROM' });
    const to = await setupBatch(owner, { initialCount: 100, code: 'B-TO' });

    const moved = await push(keeper, [
      {
        table: 'bird_transfers',
        id: randomUUID(),
        data: {
          fromBatchId: from.batchId,
          toBatchId: to.batchId,
          count: 40,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(moved.results[0]?.status).toBe('accepted');

    const changes = await pull(owner);
    const mortality = changes.filter((change) => change.table === 'mortality_events');
    const sales = changes.filter((change) => change.table === 'bird_sales');
    const transfers = changes.filter((change) => change.table === 'bird_transfers');

    const fromCounts = batchCounts({
      initialCount: from.initialCount,
      mortality: mortality
        .filter((change) => change.data['batchId'] === from.batchId)
        .map((change) => Number(change.data['count'])),
      sold: sales
        .filter((change) => change.data['batchId'] === from.batchId)
        .map((change) => Number(change.data['count'])),
      transferredOut: transfers
        .filter((change) => change.data['fromBatchId'] === from.batchId)
        .map((change) => Number(change.data['count'])),
      transferredIn: transfers
        .filter((change) => change.data['toBatchId'] === from.batchId)
        .map((change) => Number(change.data['count'])),
    });
    const toCounts = batchCounts({
      initialCount: to.initialCount,
      mortality: [],
      sold: [],
      transferredOut: transfers
        .filter((change) => change.data['fromBatchId'] === to.batchId)
        .map((change) => Number(change.data['count'])),
      transferredIn: transfers
        .filter((change) => change.data['toBatchId'] === to.batchId)
        .map((change) => Number(change.data['count'])),
    });

    expect(fromCounts.live).toBe(460);
    expect(toCounts.live).toBe(140);
  });

  it('records both vaccinations and rejects an unscheduled dose', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const { batchId } = await setupBatch(owner);

    const valid = await push(keeper, [
      {
        table: 'vaccination_events',
        id: randomUUID(),
        data: { batchId, day: 12, recordedAt: new Date().toISOString() },
      },
      {
        table: 'vaccination_events',
        id: randomUUID(),
        data: { batchId, day: 21, recordedAt: new Date().toISOString() },
      },
    ]);
    expect(valid.results.every((result) => result.status === 'accepted')).toBe(true);

    const invalid = await push(keeper, [
      {
        table: 'vaccination_events',
        id: randomUUID(),
        data: { batchId, day: 14, recordedAt: new Date().toISOString() },
      },
    ]);
    expect(invalid.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_record' });
  });
});

describe('feed store', () => {
  it('receives and issues feed in kilograms', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const { batchId } = await setupBatch(owner);
    const itemId = await setupStockItem(owner, 'Growers mash');

    const response = await push(keeper, [
      {
        table: 'stock_movements',
        id: randomUUID(),
        data: {
          stockItemId: itemId,
          kind: 'receipt',
          quantityKg: 500,
          recordedAt: new Date().toISOString(),
        },
      },
      {
        table: 'stock_movements',
        id: randomUUID(),
        data: {
          stockItemId: itemId,
          kind: 'issue',
          quantityKg: 120.5,
          batchId,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results.every((result) => result.status === 'accepted')).toBe(true);

    const changes = await pull(owner);
    const movements = changes
      .filter((change) => change.table === 'stock_movements')
      .map((change) => ({
        kind: change.data['kind'] as 'receipt' | 'issue' | 'adjustment',
        quantityKg: Number(change.data['quantityKg']),
      }));

    expect(stockOnHand(movements)).toBe(379.5);
  });

  it('refuses a stock adjustment from a worker', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const itemId = await setupStockItem(owner);

    const response = await push(keeper, [
      {
        table: 'stock_movements',
        id: randomUUID(),
        data: {
          stockItemId: itemId,
          kind: 'adjustment',
          quantityKg: -5,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });
});

describe('tenant boundaries', () => {
  it('will not attach a record to another farm’s batch', async () => {
    const farmA = await registerFarm();
    const { batchId } = await setupBatch(farmA);
    const farmB = await registerFarm();

    const response = await push(farmB, [
      {
        table: 'mortality_events',
        id: randomUUID(),
        data: { batchId, count: 1, recordedAt: new Date().toISOString() },
      },
    ]);

    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_batch' });
  });

  it('does not pull another farm’s poultry records', async () => {
    const farmA = await registerFarm();
    await setupBatch(farmA);
    const farmB = await registerFarm();

    const changes = await pull(farmB);
    expect(changes).toHaveLength(0);
  });
});

describe('feed cost and growth', () => {
  it('records a delivery price and pulls it back', async () => {
    const owner = await registerFarm();
    const itemId = await setupStockItem(owner);
    const id = randomUUID();

    const response = await push(owner, [
      {
        table: 'stock_movements',
        id,
        data: {
          stockItemId: itemId,
          kind: 'receipt',
          quantityKg: 500,
          unitCostKesPerKg: 68.5,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]?.status).toBe('accepted');

    const changes = await pull(owner);
    expect(changes.find((change) => change.id === id)?.data).toMatchObject({
      kind: 'receipt',
      quantityKg: 500,
      unitCostKesPerKg: 68.5,
    });
  });

  it('refuses a price on feed already issued', async () => {
    const owner = await registerFarm();
    const itemId = await setupStockItem(owner);
    const { batchId } = await setupBatch(owner);

    const response = await push(owner, [
      {
        table: 'stock_movements',
        id: randomUUID(),
        data: {
          stockItemId: itemId,
          kind: 'issue',
          quantityKg: 20,
          batchId,
          unitCostKesPerKg: 68.5,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_record' });
  });

  it('records a weighing and pulls it back with its average', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);
    const { batchId } = await setupBatch(owner);
    const id = randomUUID();

    const response = await push(keeper, [
      {
        table: 'batch_weights',
        id,
        data: {
          batchId,
          sampleCount: 20,
          averageWeightKg: 1.85,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]?.status).toBe('accepted');

    const changes = await pull(owner);
    expect(changes.find((change) => change.id === id)?.data).toMatchObject({
      batchId,
      sampleCount: 20,
      averageWeightKg: 1.85,
    });
  });

  it('keeps weighing away from a salesperson', async () => {
    const owner = await registerFarm();
    const seller = await createSalesperson(owner);
    const { batchId } = await setupBatch(owner);

    const response = await push(seller, [
      {
        table: 'batch_weights',
        id: randomUUID(),
        data: {
          batchId,
          sampleCount: 10,
          averageWeightKg: 2.1,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });

  it('refuses a weighing with no birds or no positive weight', async () => {
    const owner = await registerFarm();
    const { batchId } = await setupBatch(owner);

    const response = await push(owner, [
      {
        table: 'batch_weights',
        id: randomUUID(),
        data: {
          batchId,
          sampleCount: 0,
          averageWeightKg: 1.5,
          recordedAt: new Date().toISOString(),
        },
      },
      {
        table: 'batch_weights',
        id: randomUUID(),
        data: {
          batchId,
          sampleCount: 10,
          averageWeightKg: 0,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results.map((result) => result.reason)).toEqual([
      'invalid_record',
      'invalid_record',
    ]);
  });

  it('will not weigh birds in another farm’s batch', async () => {
    const farmA = await registerFarm();
    const { batchId } = await setupBatch(farmA);
    const farmB = await registerFarm();

    const response = await push(farmB, [
      {
        table: 'batch_weights',
        id: randomUUID(),
        data: {
          batchId,
          sampleCount: 10,
          averageWeightKg: 2,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_batch' });
  });
});
