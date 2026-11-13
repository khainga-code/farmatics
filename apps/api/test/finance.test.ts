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
 * Finance over the real sync endpoints.
 *
 * The farm keeps a cash book: a sale carries the price it was sold at, an
 * expense carries the amount paid, and a decision approves or rejects it. The
 * tests below cover the parts the phone cannot enforce on its own - permissions
 * and one-decision-per-expense.
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
  return `0750${String(phoneCounter).padStart(6, '0')}`;
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
  const username = `worker${phoneCounter}`;
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

/** A house and one batch that is old enough to sell from. */
async function setupBatch(owner: TokenBundle, arrivalDaysAgo = 30) {
  const houseId = randomUUID();
  const batchId = randomUUID();
  const response = await push(owner, [
    { table: 'houses', id: houseId, data: { name: 'House 1' } },
    {
      table: 'batches',
      id: batchId,
      data: {
        houseId,
        code: `B-${batchId.slice(0, 6)}`,
        breed: 'Ross 308',
        arrivalDate: dayOnly(new Date(Date.now() - arrivalDaysAgo * DAY_MS)),
        initialCount: 500,
      },
    },
  ]);
  expect(response.results.map((result) => result.status)).toEqual(['accepted', 'accepted']);
  return { houseId, batchId };
}

async function recordExpense(
  bundle: TokenBundle,
  data: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const response = await push(bundle, [
    {
      table: 'expenses',
      id,
      data: {
        category: 'transport',
        amountKes: 1500,
        recordedAt: new Date().toISOString(),
        ...data,
      },
    },
  ]);
  expect(response.results[0]?.status).toBe('accepted');
  return id;
}

describe('expenses', () => {
  it('lets the owner and a farm manager record an expense', async () => {
    const owner = await registerFarm();
    const manager = await createEmployee(owner, 'farm_manager');

    const ownerExpense = await recordExpense(owner, { category: 'feed', amountKes: 2400 });
    const managerExpense = await recordExpense(manager, {
      category: 'labour',
      amountKes: 800,
      paidTo: 'Joseph',
      method: 'mpesa',
    });

    const changes = await pull(owner);
    const ownerRow = changes.find((change) => change.id === ownerExpense);
    const managerRow = changes.find((change) => change.id === managerExpense);

    expect(ownerRow?.data).toMatchObject({ category: 'feed', amountKes: 2400 });
    expect(managerRow?.data).toMatchObject({
      category: 'labour',
      amountKes: 800,
      paidTo: 'Joseph',
      method: 'mpesa',
    });
  });

  it('refuses an expense from a stock keeper', async () => {
    const owner = await registerFarm();
    const keeper = await createEmployee(owner, 'stock_keeper');

    const response = await push(keeper, [
      {
        table: 'expenses',
        id: randomUUID(),
        data: {
          category: 'feed',
          amountKes: 900,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);

    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });

  it('refuses a zero or negative amount', async () => {
    const owner = await registerFarm();

    const response = await push(owner, [
      {
        table: 'expenses',
        id: randomUUID(),
        data: {
          category: 'other',
          amountKes: 0,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);

    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_record' });
  });
});

describe('approvals', () => {
  it('approves once and refuses a second, different decision', async () => {
    const owner = await registerFarm();
    const manager = await createEmployee(owner, 'farm_manager');
    const expenseId = await recordExpense(owner);

    const first = await push(manager, [
      {
        table: 'expense_approvals',
        id: randomUUID(),
        data: {
          expenseId,
          decision: 'approved',
          note: 'Fuel to market',
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(first.results[0]?.status).toBe('accepted');

    const second = await push(owner, [
      {
        table: 'expense_approvals',
        id: randomUUID(),
        data: { expenseId, decision: 'rejected', recordedAt: new Date().toISOString() },
      },
    ]);
    expect(second.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'already_decided',
    });

    const changes = await pull(owner);
    const decisions = changes.filter(
      (change) => change.table === 'expense_approvals' && change.data['expenseId'] === expenseId,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.data['decision']).toBe('approved');
  });

  it('refuses an approval from a stock keeper', async () => {
    const owner = await registerFarm();
    const keeper = await createEmployee(owner, 'stock_keeper');
    const expenseId = await recordExpense(owner);

    const response = await push(keeper, [
      {
        table: 'expense_approvals',
        id: randomUUID(),
        data: { expenseId, decision: 'approved', recordedAt: new Date().toISOString() },
      },
    ]);

    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });

  it('refuses an approval for an expense on another farm', async () => {
    const farmA = await registerFarm();
    const farmB = await registerFarm();
    const expenseId = await recordExpense(farmA);

    const response = await push(farmB, [
      {
        table: 'expense_approvals',
        id: randomUUID(),
        data: { expenseId, decision: 'approved', recordedAt: new Date().toISOString() },
      },
    ]);

    expect(response.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'unknown_expense',
    });
  });
});

describe('sale prices', () => {
  it('stores the price per bird and returns it on pull', async () => {
    const owner = await registerFarm();
    const { batchId } = await setupBatch(owner);
    const saleId = randomUUID();

    const response = await push(owner, [
      {
        table: 'bird_sales',
        id: saleId,
        data: {
          batchId,
          count: 120,
          unitPriceKes: 350,
          buyer: 'Mama Njeri',
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    expect(response.results[0]?.status).toBe('accepted');

    const changes = await pull(owner);
    const sale = changes.find((change) => change.id === saleId);
    expect(sale?.data).toMatchObject({ count: 120, unitPriceKes: 350 });
  });

  it('keeps an unpriced sale as null rather than zero', async () => {
    const owner = await registerFarm();
    const { batchId } = await setupBatch(owner);
    const saleId = randomUUID();

    await push(owner, [
      {
        table: 'bird_sales',
        id: saleId,
        data: { batchId, count: 5, recordedAt: new Date().toISOString() },
      },
    ]);

    const changes = await pull(owner);
    const sale = changes.find((change) => change.id === saleId);
    expect(sale?.data['unitPriceKes']).toBeNull();
  });

  it('will not tag an expense to another farm’s batch', async () => {
    const farmA = await registerFarm();
    const { batchId } = await setupBatch(farmA);
    const farmB = await registerFarm();

    const response = await push(farmB, [
      {
        table: 'expenses',
        id: randomUUID(),
        data: {
          category: 'feed',
          amountKes: 1000,
          batchId,
          recordedAt: new Date().toISOString(),
        },
      },
    ]);

    expect(response.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_batch' });
  });
});
