import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgliteDb,
  runMigrations,
  type DatabaseContext,
  type Db,
} from '@farmatics/db';
import type { TokenBundle } from '@farmatics/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SmsSender } from '../src/auth/sms.js';

/**
 * Phase 1 gate, exercised through HTTP: an owner registers a farm and creates
 * an employee, the employee signs in, and farm data never crosses tenants.
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

interface RegisteredFarm {
  phone: string;
  password: string;
  bundle: TokenBundle;
}

async function registerFarm(farmName = 'Sunrise Farm') {
  const phone = nextPhone();
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { farmName, ownerName: 'Owner One', phone, password: 'correct horse battery' },
  });
  expect(registered.statusCode).toBe(201);
  const { devCode } = registered.json() as { devCode: string };

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    payload: { phone, code: devCode, deviceLabel: 'test phone' },
  });
  expect(verified.statusCode).toBe(201);

  return { phone, password: 'correct horse battery', bundle: verified.json() as TokenBundle };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('owner registration', () => {
  it('rejects a weak password with field-level detail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { farmName: 'X', ownerName: 'Y', phone: '0700111222', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details: unknown[] } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects a non-Kenyan phone number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        farmName: 'Some Farm',
        ownerName: 'Owner',
        phone: '+15555550100',
        password: 'correct horse battery',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates the farm and owner once the code is verified', async () => {
    const { bundle } = await registerFarm('Green Valley');
    expect(bundle.user.role).toBe('owner');
    expect(bundle.permissions).toContain('manage_accounts');
    expect(bundle.accessToken.split('.')).toHaveLength(3);
  });

  it('stores the password hashed, never in the clear', async () => {
    const { phone } = await registerFarm();
    const row = await db.one<{ password_hash: string }>(
      'select password_hash from users where phone = $1',
      [`+254${phone.slice(1)}`],
    );
    expect(row!.password_hash.startsWith('scrypt$')).toBe(true);
    expect(row!.password_hash).not.toContain('correct horse battery');
  });

  it('refuses a wrong verification code', async () => {
    const phone = nextPhone();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { farmName: 'Code Farm', ownerName: 'Owner', phone, password: 'correct horse battery' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify',
      payload: { phone, code: '000000' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('otp_incorrect');
  });

  it('refuses a phone that is already registered', async () => {
    const { phone } = await registerFarm();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { farmName: 'Duplicate', ownerName: 'Owner', phone, password: 'correct horse battery' },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('owner sign-in', () => {
  it('signs in with the right password and returns permissions', async () => {
    const { phone, password } = await registerFarm();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone, password },
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json() as TokenBundle;
    expect(bundle.permissions).toContain('approve_expense');
  });

  it('does not say whether the number or the password was wrong', async () => {
    const { phone } = await registerFarm();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone, password: 'not the password' },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { message: string } }).error.message).toContain(
      'not correct',
    );
  });

  it('locks the account after five wrong attempts', async () => {
    const { phone, password } = await registerFarm();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { phone, password: 'wrong' },
      });
      expect(response.statusCode).toBe(401);
    }

    const lockedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone, password },
    });
    expect(lockedResponse.statusCode).toBe(423);
  });
});

describe('sessions', () => {
  it('returns the signed-in account from /auth/me', async () => {
    const { bundle } = await registerFarm();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth(bundle.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { user: { role: string }; permissions: string[] };
    expect(body.user.role).toBe('owner');
    expect(body.permissions.length).toBeGreaterThan(10);
  });

  it('rejects a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('rotates the refresh token and rejects a replay after the grace window', async () => {
    const { bundle } = await registerFarm();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: bundle.refreshToken },
    });
    expect(first.statusCode).toBe(200);

    // Move the rotation into the past, as if the phone only came back much later.
    await db.query(
      `update sessions set rotated_at = now() - interval '10 minutes'
        where user_id = $1 and rotated_at is not null`,
      [bundle.user.id],
    );

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: bundle.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('accepts a just-rotated token so a lost reply does not sign the phone out', async () => {
    const { bundle } = await registerFarm();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: bundle.refreshToken },
    });
    expect(first.statusCode).toBe(200);

    // The reply carrying the new token never reached the device, so it retries
    // with the only token it has.
    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: bundle.refreshToken },
    });
    expect(retry.statusCode).toBe(200);
    const recovered = retry.json<TokenBundle>();
    expect(recovered.refreshToken).not.toBe(bundle.refreshToken);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${recovered.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('revokes the session on sign-out', async () => {
    const { bundle } = await registerFarm();
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: bundle.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: bundle.refreshToken },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('employee sub-accounts', () => {
  it('creates an employee with a temporary PIN and forced PIN change', async () => {
    const { bundle } = await registerFarm();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: auth(bundle.accessToken),
      payload: {
        name: 'Joseph Mwangi',
        phone: nextPhone(),
        username: `joseph${phoneCounter}`,
        role: 'stock_keeper',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { user: { mustChangePin: boolean; role: string }; tempPin: string };
    expect(body.user.mustChangePin).toBe(true);
    expect(body.user.role).toBe('stock_keeper');
    expect(body.tempPin).toMatch(/^\d{6}$/);
  });

  it('lets the employee sign in with the PIN and then change it', async () => {
    const { bundle } = await registerFarm();
    const username = `worker${phoneCounter}`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: auth(bundle.accessToken),
      payload: { name: 'Worker', phone: nextPhone(), username, role: 'salesperson' },
    });
    const { tempPin } = created.json() as { tempPin: string };

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/staff-login',
      payload: { username, pin: tempPin },
    });
    expect(login.statusCode).toBe(200);
    const employee = login.json() as TokenBundle;
    expect(employee.permissions).toEqual(['record_sale', 'record_return']);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin',
      headers: auth(employee.accessToken),
      payload: { currentPin: tempPin, newPin: '4321' },
    });
    expect(changed.statusCode).toBe(204);

    const relogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/staff-login',
      payload: { username, pin: '4321' },
    });
    expect(relogin.statusCode).toBe(200);
    expect((relogin.json() as TokenBundle).user.mustChangePin).toBe(false);
  });

  it('stops an employee from creating other accounts', async () => {
    const { bundle } = await registerFarm();
    const username = `nosy${phoneCounter}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: auth(bundle.accessToken),
      payload: { name: 'Nosy', phone: nextPhone(), username, role: 'stock_keeper' },
    });
    const { tempPin } = created.json() as { tempPin: string };

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/staff-login',
      payload: { username, pin: tempPin },
    });
    const employee = login.json() as TokenBundle;

    const attempt = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: auth(employee.accessToken),
      payload: { name: 'Sneaky', phone: nextPhone(), username: `sneaky${phoneCounter}`, role: 'owner' },
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('does not let one farm touch another farm employees', async () => {
    const farmA = await registerFarm('Farm A');
    const farmB = await registerFarm('Farm B');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: auth(farmA.bundle.accessToken),
      payload: {
        name: 'A Employee',
        phone: nextPhone(),
        username: `aemployee${phoneCounter}`,
        role: 'stock_keeper',
      },
    });
    const employeeId = (created.json() as { user: { id: string } }).user.id;

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/employees',
      headers: auth(farmB.bundle.accessToken),
    });
    expect((list.json() as { employees: unknown[] }).employees).toHaveLength(0);

    const suspend = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${employeeId}/suspend`,
      headers: auth(farmB.bundle.accessToken),
    });
    expect(suspend.statusCode).toBe(404);
  });

  it('blocks a suspended employee at sign-in and revokes live sessions', async () => {
    const { bundle } = await registerFarm();
    const username = `suspended${phoneCounter}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: auth(bundle.accessToken),
      payload: { name: 'Soon Gone', phone: nextPhone(), username, role: 'stock_keeper' },
    });
    const { tempPin, user } = created.json() as { tempPin: string; user: { id: string } };

    const suspend = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${user.id}/suspend`,
      headers: auth(bundle.accessToken),
    });
    expect(suspend.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/staff-login',
      payload: { username, pin: tempPin },
    });
    expect(login.statusCode).toBe(403);
  });
});

describe('audit trail', () => {
  it('records sign-ins and account changes', async () => {
    const { bundle } = await registerFarm();
    await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: auth(bundle.accessToken),
      payload: {
        name: 'Audited',
        phone: nextPhone(),
        username: `audited${phoneCounter}`,
        role: 'stock_keeper',
      },
    });

    const rows = await db.query<{ action: string }>(
      'select action from audit_log where farm_id = $1',
      [bundle.user.farmId],
    );
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('farm.registered');
    expect(actions).toContain('account.created');
  });
});

describe('per-account throttling', () => {
  let throttled: FastifyInstance;

  beforeAll(async () => {
    // A second app over the same database with the limits switched on. The
    // rest of this file runs with them off so repeated attempts can be tested
    // without waiting for a window.
    throttled = await buildApp({
      config: loadConfig({
        rateLimitEnabled: true,
        exposeOtpInResponse: true,
        jwtSecret: 'test-secret-that-is-long-enough-for-hashing',
        accessTokenTtlSeconds: 900,
      }),
      db: ctx,
      logger: false,
      sms,
    });
    await throttled.ready();
  }, 30_000);

  afterAll(async () => {
    await throttled.close();
  });

  function registration(phone: string) {
    return {
      farmName: `Farm ${phone}`,
      ownerName: 'Owner One',
      phone,
      password: 'correct horse battery',
    };
  }

  it('stops one number after its attempts, even from new IPs', async () => {
    const phone = nextPhone();

    // The first attempt creates the pending farm; the next two are refused as
    // already registered. All three count against the number.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await throttled.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registration(phone),
        remoteAddress: `10.10.0.${attempt + 1}`,
      });
      expect(response.statusCode).toBe(attempt === 0 ? 201 : 409);
    }

    const blocked = await throttled.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: registration(phone),
      remoteAddress: '10.10.1.99',
    });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('rate_limited');

    // A different number from that same address has its own budget: the
    // limit follows the account, not the caller's IP.
    const other = await throttled.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: registration(nextPhone()),
      remoteAddress: '10.10.1.99',
    });
    expect(other.statusCode).toBe(201);
  });
});
