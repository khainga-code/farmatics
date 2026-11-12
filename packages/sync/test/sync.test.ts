import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FarmDto, UserDto } from '@farmatics/shared';
import {
  createPinVerifier,
  createSyncClient,
  deleteFarmaticsDb,
  FarmaticsDb,
  loadSession,
  offlineExpired,
  saveSession,
  setPinVerifier,
  unlockSession,
  verifyPin,
  type SyncTransport,
} from '../src/index.js';

/**
 * The engine is tested here against a hand-written transport. The end-to-end
 * case - two phones, both offline, both reconnecting - lives in
 * apps/api/test/two-phone.test.ts against the real API.
 */

const openDbs: FarmaticsDb[] = [];

function newDb(): FarmaticsDb {
  const db = new FarmaticsDb(`farmatics-test-${randomUUID()}`);
  openDbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of openDbs.splice(0)) {
    await deleteFarmaticsDb(db);
  }
});

function transport(overrides: Partial<SyncTransport> = {}): SyncTransport {
  return {
    push: async () => ({ results: [], serverTime: new Date().toISOString() }),
    pull: async () => ({
      changes: [],
      cursor: '0',
      hasMore: false,
      serverTime: new Date().toISOString(),
    }),
    ...overrides,
  };
}

const user: UserDto = {
  id: randomUUID(),
  farmId: randomUUID(),
  name: 'Joseph Mwangi',
  phone: '+254722334455',
  username: 'joseph',
  role: 'stock_keeper',
  status: 'active',
  mustChangePin: false,
  lastLoginAt: null,
};

const farm: FarmDto = {
  id: user.farmId,
  name: 'D Ayo Farm',
  currency: 'KES',
  offlineDaysAllowed: 14,
};

describe('local writes and push', () => {
  it('queues a save in one transaction and clears it when accepted', async () => {
    const db = newDb();
    const id = randomUUID();
    const client = createSyncClient({
      db,
      transport: transport({
        push: async (records) => ({
          results: records.map((record) => ({
            table: record.table,
            id: record.id,
            status: 'accepted' as const,
            changeSeq: '41',
          })),
          serverTime: new Date().toISOString(),
        }),
      }),
    });

    await client.saveRecord('probes', id, { label: 'eggs', value: 12 });
    expect(await client.pendingCount()).toBe(1);

    const local = await client.getRecord('probes', id);
    expect(local?.dirty).toBe(true);
    expect(local?.changeSeq).toBeNull();

    const outcome = await client.push();
    expect(outcome).toMatchObject({ attempted: 1, accepted: 1, rejected: 0 });
    expect(await client.pendingCount()).toBe(0);

    const synced = await client.getRecord('probes', id);
    expect(synced?.dirty).toBe(false);
    expect(synced?.changeSeq).toBe('41');
  });

  it('treats a duplicate as success, not as work still waiting', async () => {
    const db = newDb();
    const id = randomUUID();
    const client = createSyncClient({
      db,
      transport: transport({
        push: async (records) => ({
          results: records.map((record) => ({
            table: record.table,
            id: record.id,
            status: 'duplicate' as const,
            changeSeq: '9',
          })),
          serverTime: new Date().toISOString(),
        }),
      }),
    });

    await client.saveRecord('probes', id, { label: 'eggs', value: 1 });
    const outcome = await client.push();

    expect(outcome.duplicated).toBe(1);
    expect(await client.pendingCount()).toBe(0);
    expect((await client.getRecord('probes', id))?.changeSeq).toBe('9');
  });

  it('parks a rejected record in the attention list instead of retrying forever', async () => {
    const db = newDb();
    const id = randomUUID();
    const client = createSyncClient({
      db,
      transport: transport({
        push: async (records) => ({
          results: records.map((record) => ({
            table: record.table,
            id: record.id,
            status: 'rejected' as const,
            reason: 'invalid_record',
            message: 'The value is not valid.',
          })),
          serverTime: new Date().toISOString(),
        }),
      }),
    });

    await client.saveRecord('probes', id, { label: 'eggs', value: -1 });
    const outcome = await client.push();

    expect(outcome.rejected).toBe(1);
    expect(await client.pendingCount()).toBe(0);

    const attention = await client.attention();
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      id,
      table: 'probes',
      reason: 'invalid_record',
      message: 'The value is not valid.',
    });
  });

  it('keeps a record pending when the server does not answer for it', async () => {
    const db = newDb();
    const id = randomUUID();
    const client = createSyncClient({
      db,
      transport: transport({
        push: async () => ({ results: [], serverTime: new Date().toISOString() }),
      }),
    });

    await client.saveRecord('probes', id, { label: 'eggs', value: 1 });
    const outcome = await client.push();

    expect(outcome.unanswered).toBe(1);
    expect(await client.pendingCount()).toBe(1);
  });

  it('counts failed attempts and reports offline without losing the queue', async () => {
    const db = newDb();
    const id = randomUUID();
    const client = createSyncClient({
      db,
      transport: transport({
        push: async () => {
          throw new Error('network down');
        },
      }),
    });

    await client.saveRecord('probes', id, { label: 'eggs', value: 1 });

    await expect(client.push()).rejects.toThrow('network down');
    expect(await client.pendingCount()).toBe(1);

    const queued = await db.outbox.get(`probes:${id}`);
    expect(queued?.attempts).toBe(1);

    const result = await client.sync();
    expect(result.ok).toBe(false);
    expect(result.pending).toBe(1);
    expect(result.error).toBe('network down');
  });
});

describe('pull', () => {
  it('pages through changes and remembers the cursor', async () => {
    const db = newDb();
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    const calls: Array<{ cursor: string; limit: number }> = [];

    const client = createSyncClient({
      db,
      pullLimit: 2,
      transport: transport({
        pull: async (cursor, limit) => {
          calls.push({ cursor, limit });
          if (cursor === '0') {
            return {
              changes: [
                { table: 'probes', id: first, changeSeq: '1', deletedAt: null, data: { label: 'a' } },
                { table: 'probes', id: second, changeSeq: '2', deletedAt: null, data: { label: 'b' } },
              ],
              cursor: '2',
              hasMore: true,
              serverTime: new Date().toISOString(),
            };
          }
          return {
            changes: [
              { table: 'probes', id: third, changeSeq: '3', deletedAt: null, data: { label: 'c' } },
            ],
            cursor: '3',
            hasMore: false,
            serverTime: new Date().toISOString(),
          };
        },
      }),
    });

    const outcome = await client.pull();
    expect(outcome).toEqual({ pulled: 3, cursor: '3' });
    expect(calls).toEqual([
      { cursor: '0', limit: 2 },
      { cursor: '2', limit: 2 },
    ]);
    expect(await client.getCursor()).toBe('3');
    expect((await client.listRecords('probes')).map((row) => row.id).sort()).toEqual(
      [first, second, third].sort(),
    );
  });

  it('does not overwrite a local record that is still queued', async () => {
    const db = newDb();
    const id = randomUUID();
    const client = createSyncClient({
      db,
      transport: transport({
        pull: async () => ({
          changes: [
            {
              table: 'probes',
              id,
              changeSeq: '7',
              deletedAt: null,
              data: { label: 'from server', value: 1 },
            },
          ],
          cursor: '7',
          hasMore: false,
          serverTime: new Date().toISOString(),
        }),
      }),
    });

    await client.saveRecord('probes', id, { label: 'local work', value: 99 });
    await client.pull();

    const row = await client.getRecord('probes', id);
    expect(row?.data['label']).toBe('local work');
    expect(row?.changeSeq).toBe('7');
    expect(row?.dirty).toBe(true);
  });

  it('records a delete as a tombstone rather than dropping the row', async () => {
    const db = newDb();
    const id = randomUUID();
    const client = createSyncClient({
      db,
      transport: transport({
        pull: async () => ({
          changes: [
            {
              table: 'probes',
              id,
              changeSeq: '5',
              deletedAt: new Date().toISOString(),
              data: {},
            },
          ],
          cursor: '5',
          hasMore: false,
          serverTime: new Date().toISOString(),
        }),
      }),
    });

    await client.pull();
    expect((await client.getRecord('probes', id))?.deletedAt).not.toBeNull();
  });
});

describe('offline session', () => {
  it('verifies the PIN it stored, and only that PIN', async () => {
    const verifier = await createPinVerifier('2580');
    expect(await verifyPin('2580', verifier)).toBe(true);
    expect(await verifyPin('2581', verifier)).toBe(false);
  });

  it('keeps the verifier when the session is refreshed online', async () => {
    const db = newDb();
    const verifier = await createPinVerifier('2580');

    await saveSession(db, { user, farm, permissions: ['record_sale'], deviceId: 'dev', pinVerifier: verifier });
    await saveSession(db, {
      user,
      farm,
      permissions: ['record_sale', 'record_return'],
      deviceId: 'dev',
    });

    const session = await loadSession(db);
    expect(session?.pinVerifier?.hash).toBe(verifier.hash);
    expect(session?.permissions).toEqual(['record_sale', 'record_return']);
  });

  it('unlocks with the right PIN and refuses the wrong one', async () => {
    const db = newDb();
    await saveSession(db, {
      user,
      farm,
      permissions: [],
      deviceId: 'dev',
      pinVerifier: await createPinVerifier('2580'),
    });

    expect(await unlockSession(db, '0000')).toEqual({ ok: false, reason: 'wrong-pin' });
    const unlocked = await unlockSession(db, '2580');
    expect(unlocked.ok).toBe(true);
  });

  it('refuses to unlock once the offline days have run out', async () => {
    const db = newDb();
    const lastOnline = new Date('2026-01-01T00:00:00Z');
    await saveSession(
      db,
      {
        user,
        farm: { ...farm, offlineDaysAllowed: 14 },
        permissions: [],
        deviceId: 'dev',
        pinVerifier: await createPinVerifier('2580'),
      },
      lastOnline,
    );

    const session = (await loadSession(db))!;
    expect(offlineExpired(session, new Date('2026-01-10T00:00:00Z'))).toBe(false);
    expect(offlineExpired(session, new Date('2026-01-20T00:00:00Z'))).toBe(true);
    expect(await unlockSession(db, '2580', new Date('2026-01-20T00:00:00Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses unlock when no PIN has been set on this phone', async () => {
    const db = newDb();
    await saveSession(db, { user, farm, permissions: [], deviceId: 'dev' });
    expect(await unlockSession(db, '2580')).toEqual({ ok: false, reason: 'no-pin' });
  });

  it('can clear a PIN verifier when the account is signed out', async () => {
    const db = newDb();
    await saveSession(db, {
      user,
      farm,
      permissions: [],
      deviceId: 'dev',
      pinVerifier: await createPinVerifier('2580'),
    });
    await setPinVerifier(db, null);
    expect((await loadSession(db))?.pinVerifier).toBeNull();
  });
});
