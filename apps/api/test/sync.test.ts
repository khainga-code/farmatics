import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgliteDb,
  runMigrations,
  type DatabaseContext,
  type Db,
} from '@farmatics/db';
import type {
  SyncPullResponse,
  SyncPushResponse,
  TokenBundle,
} from '@farmatics/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SmsSender } from '../src/auth/sms.js';

/**
 * The sync gate, exercised over HTTP against a real Postgres.
 *
 * The important promises:
 *   - a retried push is a duplicate, never a second row;
 *   - a bad record is rejected without failing the good ones beside it;
 *   - a pull moves forward only, and never shows another farm's rows.
 */

let app: FastifyInstance;
let db: Db;
let ctx: DatabaseContext;
let phoneCounter = 0;

const sms: SmsSender = { send: async () => {} };

function nextPhone(): string {
  phoneCounter += 1;
  return `0700${String(phoneCounter).padStart(6, '0')}`;
}

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

async function registerFarm(farmName = 'Sync Farm'): Promise<TokenBundle> {
  const phone = nextPhone();
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { farmName, ownerName: 'Owner', phone, password: 'correct horse battery' },
  });
  const { devCode } = registered.json() as { devCode: string };

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    payload: { phone, code: devCode, deviceLabel: 'sync test phone' },
  });
  expect(verified.statusCode).toBe(201);
  return verified.json() as TokenBundle;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function probe(id = randomUUID(), overrides: Record<string, unknown> = {}) {
  return {
    table: 'probes',
    id,
    data: {
      label: 'mortality count',
      value: 3,
      recordedAt: new Date().toISOString(),
      ...overrides,
    },
  };
}

async function push(token: string, records: unknown[]): Promise<SyncPushResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: auth(token),
    payload: { records },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SyncPushResponse;
}

async function pull(
  token: string,
  cursor = '0',
  limit = 100,
): Promise<SyncPullResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/sync/pull?cursor=${cursor}&limit=${limit}`,
    headers: auth(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SyncPullResponse;
}

describe('sync push', () => {
  it('requires a signed-in device', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      payload: { records: [probe()] },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a client-generated record and returns its change sequence', async () => {
    const token = (await registerFarm()).accessToken;
    const record = probe();

    const result = await push(token, [record]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('accepted');
    expect(result.results[0]!.changeSeq).toMatch(/^\d+$/);
  });

  it('reports the same record as a duplicate and stores it only once', async () => {
    const token = (await registerFarm()).accessToken;
    const record = probe();

    const first = await push(token, [record]);
    const second = await push(token, [record]);

    expect(first.results[0]!.status).toBe('accepted');
    expect(second.results[0]!.status).toBe('duplicate');
    expect(second.results[0]!.changeSeq).toBe(first.results[0]!.changeSeq);

    const count = await db.one<{ count: string }>(
      'select count(*)::text as count from probes where id = $1',
      [record.id],
    );
    expect(count!.count).toBe('1');
  });

  it('rejects an invalid record without failing the good records beside it', async () => {
    const token = (await registerFarm()).accessToken;
    const good = probe();

    const result = await push(token, [
      { ...probe(), data: { label: '', value: 3, recordedAt: new Date().toISOString() } },
      good,
      { table: 'goats', id: randomUUID(), data: { name: 'not a synced table' } },
      { table: 'probes', id: 'not-a-uuid', data: {} },
    ]);

    expect(result.results.map((entry) => entry.status)).toEqual([
      'rejected',
      'accepted',
      'rejected',
      'rejected',
    ]);
    expect(result.results[0]!.reason).toBe('invalid_record');
    expect(result.results[2]!.reason).toBe('unknown_table');
    expect(result.results[3]!.reason).toBe('invalid_id');
  });

  it('refuses an id that another farm already owns', async () => {
    const farmA = await registerFarm('Farm A');
    const farmB = await registerFarm('Farm B');
    const record = probe();

    const accepted = await push(farmA.accessToken, [record]);
    expect(accepted.results[0]!.status).toBe('accepted');

    const collision = await push(farmB.accessToken, [record]);
    expect(collision.results[0]!.status).toBe('rejected');
    expect(collision.results[0]!.reason).toBe('id_conflict');

    // The original row keeps its owner.
    const row = await db.one<{ farm_id: string }>('select farm_id from probes where id = $1', [
      record.id,
    ]);
    expect(row!.farm_id).toBe(farmA.user.farmId);
  });

  it('stamps the record with the caller, not with anything in the payload', async () => {
    const token = (await registerFarm()).accessToken;
    const record = probe();

    const forged = {
      ...record,
      data: {
        ...record.data,
        farmId: randomUUID(),
        recordedBy: randomUUID(),
      },
    };
    const result = await push(token, [forged]);
    expect(result.results[0]!.status).toBe('accepted');

    const row = await db.one<{ farm_id: string; recorded_by: string }>(
      'select farm_id, recorded_by from probes where id = $1',
      [record.id],
    );
    const me = await whoAmI(token);
    expect(row!.farm_id).toBe(me.farmId);
    expect(row!.recorded_by).toBe(me.id);
  });

  it('records how far the phone clock is from the server', async () => {
    const token = (await registerFarm()).accessToken;
    const record = probe(randomUUID(), {
      clientTime: new Date(Date.now() - 120_000).toISOString(),
    });

    await push(token, [record]);
    const row = await db.one<{ clock_skew_seconds: number }>(
      'select clock_skew_seconds from probes where id = $1',
      [record.id],
    );
    expect(row!.clock_skew_seconds).toBeGreaterThanOrEqual(110);
  });
});

async function whoAmI(token: string): Promise<{ id: string; farmId: string }> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: auth(token),
  });
  const body = response.json() as { user: { id: string; farmId: string } };
  return body.user;
}

describe('sync pull', () => {
  it('pages forward with a cursor and only reports more when there is more', async () => {
    const token = (await registerFarm()).accessToken;
    for (let index = 0; index < 3; index += 1) {
      const result = await push(token, [probe(randomUUID(), { value: index })]);
      expect(result.results[0]!.status).toBe('accepted');
    }

    const first = await pull(token, '0', 2);
    expect(first.changes).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe(first.changes[1]!.changeSeq);

    const second = await pull(token, first.cursor, 2);
    expect(second.changes).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(BigInt(second.cursor)).toBeGreaterThan(BigInt(first.cursor));

    const third = await pull(token, second.cursor, 2);
    expect(third.changes).toHaveLength(0);
    // An empty page must not rewind the cursor.
    expect(third.cursor).toBe(second.cursor);
  });

  it('never shows another farm what it recorded', async () => {
    const farmA = await registerFarm('Pull A');
    const farmB = await registerFarm('Pull B');

    const record = probe();
    await push(farmA.accessToken, [record]);

    const seenByB = await pull(farmB.accessToken);
    expect(seenByB.changes).toHaveLength(0);

    const seenByA = await pull(farmA.accessToken);
    expect(seenByA.changes.map((change) => change.id)).toContain(record.id);
  });

  it('sends the business fields back in camelCase with the change sequence', async () => {
    const token = (await registerFarm()).accessToken;
    const record = probe();
    await push(token, [record]);

    const page = await pull(token);
    const change = page.changes.find((entry) => entry.id === record.id)!;
    expect(change.table).toBe('probes');
    expect(change.deletedAt).toBeNull();
    expect(change.data['label']).toBe('mortality count');
    expect(change.data['value']).toBe(3);
    expect(typeof change.data['recordedAt']).toBe('string');
    expect(change.data['recordedBy']).toBe((await whoAmI(token)).id);
  });

  it('rejects a malformed cursor', async () => {
    const token = (await registerFarm()).accessToken;
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?cursor=tomorrow',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(400);
  });

  it('tracks the last cursor pulled by this device', async () => {
    const bundle = await registerFarm();
    const record = probe();
    await push(bundle.accessToken, [record]);

    const page = await pull(bundle.accessToken);
    const state = await db.one<{ last_pull_seq: string; last_push_at: unknown }>(
      'select last_pull_seq, last_push_at from device_sync_state where device_id = $1',
      [bundle.deviceId],
    );
    expect(state).not.toBeNull();
    expect(String(state!.last_pull_seq)).toBe(page.cursor);
    expect(state!.last_push_at).not.toBeNull();
  });
});
