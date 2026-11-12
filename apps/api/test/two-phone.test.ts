import 'fake-indexeddb/auto';
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
  SyncPushRecord,
  SyncPushResponse,
  TokenBundle,
} from '@farmatics/shared';
import {
  createSyncClient,
  deleteFarmaticsDb,
  FarmaticsDb,
  type SyncClient,
  type SyncTransport,
} from '@farmatics/sync';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SmsSender } from '../src/auth/sms.js';

/**
 * The Phase 1 gate, end to end:
 *
 *   two phones go offline, each records work, both reconnect, and nothing is
 *   lost or counted twice.
 *
 * The phones are real Dexie databases backed by fake-indexeddb. The transport
 * is the real Fastify app over `inject`, with real tokens, real Postgres and
 * real row level security. Only the network itself is simulated.
 */

let app: FastifyInstance;
let db: Db;
let ctx: DatabaseContext;
const phones: FarmaticsDb[] = [];

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
  for (const phone of phones.splice(0)) {
    await deleteFarmaticsDb(phone);
  }
  await app.close();
  await db.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function newPhone(name: string): FarmaticsDb {
  const phone = new FarmaticsDb(`farmatics-phone-${name}-${randomUUID()}`);
  phones.push(phone);
  return phone;
}

interface TransportOptions {
  /** Drops the response after the server accepted the batch, once. */
  dropAckOnce?: boolean;
}

function phoneTransport(
  bundle: TokenBundle,
  options: TransportOptions = {},
): SyncTransport & { pushes: number } {
  let dropAck = options.dropAckOnce ?? false;

  const transport: SyncTransport & { pushes: number } = {
    pushes: 0,

    async push(records: SyncPushRecord[]): Promise<SyncPushResponse> {
      transport.pushes += 1;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: auth(bundle.accessToken),
        payload: { deviceId: bundle.deviceId, records },
      });
      if (response.statusCode !== 200) {
        throw new Error(`push failed: ${response.statusCode}`);
      }
      const body = response.json() as SyncPushResponse;

      if (dropAck) {
        dropAck = false;
        // The records are on the server; the phone never heard back. This is
        // the case that would double-count without client-generated ids.
        throw new Error('connection dropped after upload');
      }
      return body;
    },

    async pull(cursor: string, limit: number): Promise<SyncPullResponse> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sync/pull?cursor=${cursor}&limit=${limit}`,
        headers: auth(bundle.accessToken),
      });
      if (response.statusCode !== 200) {
        throw new Error(`pull failed: ${response.statusCode}`);
      }
      return response.json() as SyncPullResponse;
    },
  };

  return transport;
}

async function registerFarm() {
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      farmName: 'D Ayo Farm',
      ownerName: 'Samuel Khainga',
      phone: '0712000001',
      password: 'farmatics2026',
    },
  });
  const { devCode } = registered.json() as { devCode: string };

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    payload: { phone: '0712000001', code: devCode, deviceLabel: 'owner phone' },
  });
  expect(verified.statusCode).toBe(201);
  return verified.json() as TokenBundle;
}

async function createStockKeeper(owner: TokenBundle) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/employees',
    headers: auth(owner.accessToken),
    payload: {
      name: 'Joseph Mwangi',
      phone: '0722000002',
      username: 'joseph',
      role: 'stock_keeper',
    },
  });
  expect(created.statusCode).toBe(201);
  const { tempPin } = created.json() as { tempPin: string };

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/staff-login',
    payload: { username: 'joseph', pin: tempPin, deviceLabel: 'staff phone' },
  });
  expect(login.statusCode).toBe(200);
  return login.json() as TokenBundle;
}

interface Recorded {
  id: string;
  label: string;
}

async function recordProbe(phone: SyncClient, label: string): Promise<Recorded> {
  const id = randomUUID();
  await phone.saveRecord('probes', id, {
    label,
    value: 1,
    recordedAt: new Date().toISOString(),
    clientTime: new Date().toISOString(),
  });
  return { id, label };
}

describe('two phones, both offline, then both reconnect', () => {
  it('loses nothing and counts nothing twice', async () => {
    const owner = await registerFarm();
    const keeper = await createStockKeeper(owner);

    const phoneA = createSyncClient({
      db: newPhone('a'),
      transport: phoneTransport(owner, { dropAckOnce: true }),
    });
    const phoneB = createSyncClient({
      db: newPhone('b'),
      transport: phoneTransport(keeper),
    });

    // ---- both phones are offline -------------------------------------------
    const a1 = await recordProbe(phoneA, 'A: morning mortality');
    const a2 = await recordProbe(phoneA, 'A: feed used');
    const b1 = await recordProbe(phoneB, 'B: evening mortality');
    const b2 = await recordProbe(phoneB, 'B: eggs collected');

    expect(await phoneA.pendingCount()).toBe(2);
    expect(await phoneB.pendingCount()).toBe(2);

    // No server contact yet.
    const before = await db.one<{ count: string }>('select count(*)::text as count from probes');
    expect(before!.count).toBe('0');

    // ---- phone A reconnects; the server saves but the answer is lost ------
    const firstAttempt = await phoneA.sync();
    expect(firstAttempt.ok).toBe(false);
    expect(firstAttempt.pending).toBe(2);

    const afterLostAck = await db.query<{ id: string }>('select id from probes order by id');
    expect(afterLostAck.map((row) => row.id).sort()).toEqual([a1.id, a2.id].sort());

    // ---- phone B reconnects and receives everything ------------------------
    const bRun = await phoneB.sync();
    expect(bRun.ok).toBe(true);
    expect(bRun.pushed.accepted).toBe(2);
    expect(bRun.pulled.pulled).toBe(4);
    expect(await phoneB.pendingCount()).toBe(0);

    // ---- phone A retries: the server calls it a duplicate ------------------
    const aRun = await phoneA.sync();
    expect(aRun.ok).toBe(true);
    expect(aRun.pushed.duplicated).toBe(2);
    expect(aRun.pushed.accepted).toBe(0);
    expect(await phoneA.pendingCount()).toBe(0);

    // ---- nothing lost, nothing doubled -------------------------------------
    const rows = await db.query<{ id: string; farm_id: string }>('select id, farm_id from probes');
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    expect(rows.every((row) => row.farm_id === owner.user.farmId)).toBe(true);

    // ---- both phones hold the same four records ----------------------------
    for (const phone of [phoneA, phoneB]) {
      const local = await phone.listRecords('probes');
      expect(local).toHaveLength(4);
      expect(new Set(local.map((row) => row.id))).toEqual(
        new Set([a1.id, a2.id, b1.id, b2.id]),
      );
      expect(local.every((row) => row.dirty === false)).toBe(true);
      expect(local.every((row) => row.changeSeq !== null)).toBe(true);
      expect(local.every((row) => row.deletedAt === null)).toBe(true);
    }

    // ---- each device keeps its own cursor ----------------------------------
    const cursors = await db.query<{ device_id: string; last_pull_seq: string }>(
      'select device_id, last_pull_seq from device_sync_state order by device_id',
    );
    expect(cursors).toHaveLength(2);
    expect(cursors.every((row) => BigInt(row.last_pull_seq) > 0n)).toBe(true);

    const max = await db.one<{ seq: string }>(
      'select max(change_seq)::text as seq from probes',
    );
    expect(cursors.map((row) => String(row.last_pull_seq))).toEqual([
      max!.seq,
      max!.seq,
    ]);

    // ---- a later record on one phone reaches the other ---------------------
    const a3 = await recordProbe(phoneA, 'A: afternoon mortality');
    await phoneA.sync();
    await phoneB.sync();

    const bView = await phoneB.getRecord('probes', a3.id);
    expect(bView?.data['label']).toBe('A: afternoon mortality');
    expect(bView?.dirty).toBe(false);
  }, 60_000);

  it('keeps two farms apart when both phones sync', async () => {
    // A second registration uses a different phone number block.
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        farmName: 'Neighbour Farm',
        ownerName: 'Neighbour',
        phone: '0733000003',
        password: 'farmatics2026',
      },
    });
    const { devCode } = registered.json() as { devCode: string };

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify',
      payload: { phone: '0733000003', code: devCode },
    });
    const neighbour = verified.json() as TokenBundle;

    const phone = createSyncClient({
      db: newPhone('neighbour'),
      transport: phoneTransport(neighbour),
    });

    const run = await phone.sync();
    expect(run.ok).toBe(true);
    // The first farm's records are invisible, even at cursor zero.
    expect(run.pulled.pulled).toBe(0);
    expect(await phone.listRecords('probes')).toHaveLength(0);
  }, 30_000);
});
