import { randomUUID } from 'node:crypto';
import type { DatabaseContext, Db } from '@farmatics/db';
import { withTenant } from '@farmatics/db';
import {
  resolvePermissions,
  type AuthProfile,
  type CreateEmployeeInput,
  type Permission,
  type RegisterFarmInput,
  type Role,
  type TokenBundle,
  type UserDto,
} from '@farmatics/shared';
import type { AppConfig } from '../config.js';
import {
  badRequest,
  conflict,
  forbidden,
  forbiddenByPolicy,
  locked,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../errors.js';
import { generateOtp, generateTempPin, hashOtp, otpMatches } from './otp.js';
import { hashSecret, verifySecret } from './password.js';
import type { SmsSender } from './sms.js';
import {
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
  type AccessClaims,
} from './tokens.js';

const MAX_ATTEMPTS = 5;
const OWNER_LOCK_MINUTES = 15;

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface DeviceInput {
  deviceId?: string | undefined;
  deviceLabel?: string | undefined;
  platform?: string | undefined;
}

interface UserRow {
  id: string;
  farm_id: string;
  name: string;
  phone: string;
  username: string | null;
  role: Role;
  status: 'active' | 'suspended';
  password_hash: string | null;
  pin_hash: string | null;
  must_change_pin: boolean;
  failed_attempts: number;
  locked_until: unknown;
  last_login_at: unknown;
}

interface UserRow {
  id: string;
  farm_id: string;
  name: string;
  phone: string;
  username: string | null;
  role: Role;
  status: 'active' | 'suspended';
  password_hash: string | null;
  pin_hash: string | null;
  must_change_pin: boolean;
  failed_attempts: number;
  locked_until: unknown;
  last_login_at: unknown;
}

interface OtpRow {
  id: string;
  phone: string;
  code_hash: string;
  payload: { farmName?: string; ownerName?: string; passwordHash?: string } | null;
  attempts: number;
  expires_at: unknown;
  consumed_at: unknown;
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asIso(value: unknown): string | null {
  return asDate(value)?.toISOString() ?? null;
}

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    farmId: row.farm_id,
    name: row.name,
    phone: row.phone,
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePin: row.must_change_pin,
    lastLoginAt: asIso(row.last_login_at),
  };
}

export interface AuthService {
  registerFarm(input: RegisterFarmInput, meta: RequestMeta): Promise<{
    phone: string;
    expiresAt: string;
    devCode?: string;
  }>;
  verifyRegistration(
    phone: string,
    code: string,
    device: DeviceInput,
    meta: RequestMeta,
  ): Promise<TokenBundle>;
  loginWithPassword(
    phone: string,
    password: string,
    device: DeviceInput,
    meta: RequestMeta,
  ): Promise<TokenBundle>;
  loginWithPin(
    username: string,
    pin: string,
    device: DeviceInput,
    meta: RequestMeta,
  ): Promise<TokenBundle>;
  refresh(refreshToken: string, meta: RequestMeta): Promise<TokenBundle>;
  logout(refreshToken: string): Promise<void>;
  profile(userId: string): Promise<AuthProfile>;
  changePin(userId: string, currentPin: string | undefined, newPin: string): Promise<void>;
  createEmployee(
    actor: AccessClaims,
    input: CreateEmployeeInput,
    meta: RequestMeta,
  ): Promise<{ user: UserDto; tempPin: string }>;
  listEmployees(farmId: string): Promise<UserDto[]>;
  setEmployeeStatus(
    actor: AccessClaims,
    employeeId: string,
    status: 'active' | 'suspended',
  ): Promise<UserDto>;
  unlockEmployee(actor: AccessClaims, employeeId: string): Promise<void>;
}

export function createAuthService(deps: {
  db: DatabaseContext;
  config: AppConfig;
  sms: SmsSender;
}): AuthService {
  const { db, config, sms } = deps;
  const { admin, app } = db;
  const otpSecret = `${config.jwtSecret}:otp`;

  async function audit(entry: {
    farmId: string;
    actorUserId?: string | null;
    action: string;
    recordType?: string;
    recordId?: string;
    ip?: string | null;
    userAgent?: string | null;
    after?: unknown;
  }): Promise<void> {
    await admin.query(
      `insert into audit_log
         (farm_id, actor_user_id, action, record_type, record_id, ip, user_agent, after)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.farmId,
        entry.actorUserId ?? null,
        entry.action,
        entry.recordType ?? null,
        entry.recordId ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        entry.after === undefined ? null : JSON.stringify(entry.after),
      ],
    );
  }

  async function loadPermissions(user: { id: string; role: Role; farm_id: string }): Promise<Permission[]> {
    const rows = await admin.query<{ permission: Permission; allowed: boolean }>(
      'select permission, allowed from permissions where user_id = $1 and farm_id = $2',
      [user.id, user.farm_id],
    );
    return resolvePermissions(user.role, rows);
  }

  async function resolveDevice(
    user: UserRow,
    input: DeviceInput,
  ): Promise<string> {
    if (input.deviceId) {
      const existing = await admin.one<{ id: string }>(
        `select id from devices
          where id = $1 and user_id = $2 and status = 'active'`,
        [input.deviceId, user.id],
      );
      if (existing) {
        await admin.query('update devices set last_seen_at = now() where id = $1', [existing.id]);
        return existing.id;
      }
    }

    const id = randomUUID();
    await admin.query(
      `insert into devices (id, farm_id, user_id, label, platform, last_seen_at)
       values ($1, $2, $3, $4, $5, now())`,
      [
        id,
        user.farm_id,
        user.id,
        input.deviceLabel ?? null,
        input.platform ?? null,
      ],
    );
    return id;
  }

  async function issueSession(
    user: UserRow,
    deviceId: string,
    meta: RequestMeta,
  ): Promise<TokenBundle> {
    const permissions = await loadPermissions(user);
    const sessionId = randomUUID();
    const refreshToken = createRefreshToken();
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000);

    await admin.query(
      `insert into sessions (id, farm_id, user_id, device_id, refresh_token_hash, expires_at, user_agent, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        user.farm_id,
        user.id,
        deviceId,
        hashRefreshToken(refreshToken),
        expiresAt,
        meta.userAgent ?? null,
        meta.ip ?? null,
      ],
    );

    const accessToken = signAccessToken(
      {
        sub: user.id,
        farm: user.farm_id,
        role: user.role,
        perms: permissions,
        sid: sessionId,
        dev: deviceId,
      },
      config.jwtSecret,
      config.accessTokenTtlSeconds,
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: config.accessTokenTtlSeconds,
      user: toUserDto(user),
      permissions,
      deviceId,
    };
  }

  async function recordFailure(user: UserRow): Promise<void> {
    const attempts = user.failed_attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      await admin.query('update users set failed_attempts = $2 where id = $1', [
        user.id,
        attempts,
      ]);
      return;
    }

    // The owner can wait out a short lock. Staff cannot, by design: the plan
    // says a locked employee account stays locked until the owner resets it.
    const lockUntil =
      user.role === 'owner'
        ? new Date(Date.now() + OWNER_LOCK_MINUTES * 60_000)
        : new Date(Date.now() + 10 * 365 * 86_400_000);

    await admin.query(
      'update users set failed_attempts = 0, locked_until = $2 where id = $1',
      [user.id, lockUntil],
    );
  }

  function assertNotLocked(user: UserRow): void {
    const until = asDate(user.locked_until);
    if (until && until.getTime() > Date.now()) {
      throw locked(
        user.role === 'owner'
          ? `Too many wrong attempts. Try again in ${OWNER_LOCK_MINUTES} minutes.`
          : 'This account is locked. Ask the farm owner to unlock it.',
      );
    }
  }

  return {
    async registerFarm(input, meta) {
      const existing = await admin.one<{ id: string }>(
        'select id from users where phone = $1 and deleted_at is null',
        [input.phone],
      );
      if (existing) {
        throw conflict('phone_taken', 'That phone number is already registered.');
      }

      await admin.query(
        `update otp_codes set consumed_at = now()
          where phone = $1 and purpose = 'register' and consumed_at is null`,
        [input.phone],
      );

      const code = generateOtp();
      const passwordHash = await hashSecret(input.password);
      const expiresAt = new Date(Date.now() + config.otpTtlMinutes * 60_000);

      await admin.query(
        `insert into otp_codes (phone, purpose, code_hash, payload, expires_at)
         values ($1, 'register', $2, $3, $4)`,
        [
          input.phone,
          hashOtp(input.phone, code, otpSecret),
          JSON.stringify({
            farmName: input.farmName,
            ownerName: input.ownerName,
            passwordHash,
          }),
          expiresAt,
        ],
      );

      await sms.send(
        input.phone,
        `Your Farmatics code is ${code}. It expires in ${config.otpTtlMinutes} minutes.`,
      );

      return {
        phone: input.phone,
        expiresAt: expiresAt.toISOString(),
        ...(config.exposeOtpInResponse ? { devCode: code } : {}),
      };
    },

    async verifyRegistration(phone, code, device, meta) {
      const otp = await admin.one<OtpRow>(
        `select id, phone, code_hash, payload, attempts, expires_at, consumed_at
           from otp_codes
          where phone = $1 and purpose = 'register' and consumed_at is null
          order by created_at desc
          limit 1`,
        [phone],
      );

      if (!otp) throw badRequest('otp_not_found', 'Request a new code.');
      if (asDate(otp.expires_at)!.getTime() <= Date.now()) {
        throw badRequest('otp_expired', 'That code has expired. Request a new one.');
      }
      if (otp.attempts >= MAX_ATTEMPTS) {
        throw tooManyRequests('otp_attempts', 'Too many wrong codes. Request a new one.');
      }
      if (!otpMatches(phone, code, otp.code_hash, otpSecret)) {
        await admin.query('update otp_codes set attempts = attempts + 1 where id = $1', [otp.id]);
        throw badRequest('otp_incorrect', 'That code is not correct.');
      }

      const payload = otp.payload;
      if (!payload?.farmName || !payload.ownerName || !payload.passwordHash) {
        throw badRequest('otp_incomplete', 'Request a new code.');
      }

      const farmId = randomUUID();
      const userId = randomUUID();

      await admin.transaction(async (tx) => {
        // Set the tenant before the farm exists, so the same policy applies to
        // the insert that will apply to every later request.
        await tx.query('select set_config($1, $2, true)', ['app.farm_id', farmId]);
        await tx.query('insert into farms (id, name) values ($1, $2)', [farmId, payload.farmName]);
        await tx.query(
          `insert into users (id, farm_id, name, phone, role, password_hash)
           values ($1, $2, $3, $4, 'owner', $5)`,
          [userId, farmId, payload.ownerName, phone, payload.passwordHash],
        );
        await tx.query('update otp_codes set consumed_at = now() where id = $1', [otp.id]);
      });

      const user: UserRow = {
        id: userId,
        farm_id: farmId,
        name: payload.ownerName,
        phone,
        username: null,
        role: 'owner',
        status: 'active',
        password_hash: payload.passwordHash,
        pin_hash: null,
        must_change_pin: false,
        failed_attempts: 0,
        locked_until: null,
        last_login_at: null,
      };

      const deviceId = await resolveDevice(user, device);
      const bundle = await issueSession(user, deviceId, meta);

      await audit({
        farmId,
        actorUserId: userId,
        action: 'farm.registered',
        recordType: 'farm',
        recordId: farmId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        after: { farmName: payload.farmName, ownerName: payload.ownerName },
      });

      return bundle;
    },

    async loginWithPassword(phone, password, device, meta) {
      const user = await admin.one<UserRow>(
        'select * from users where phone = $1 and deleted_at is null',
        [phone],
      );

      if (!user || !user.password_hash) {
        throw unauthorized('That number or password is not correct.');
      }
      if (user.status === 'suspended') {
        throw forbiddenByPolicy('account_suspended', 'This account is suspended.');
      }
      assertNotLocked(user);

      const valid = await verifySecret(password, user.password_hash);
      if (!valid) {
        await recordFailure(user);
        throw unauthorized('That number or password is not correct.');
      }

      await admin.query(
        'update users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = $1',
        [user.id],
      );

      const deviceId = await resolveDevice(user, device);
      const bundle = await issueSession(user, deviceId, meta);

      await audit({
        farmId: user.farm_id,
        actorUserId: user.id,
        action: 'auth.login',
        recordType: 'user',
        recordId: user.id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });

      return bundle;
    },

    async loginWithPin(username, pin, device, meta) {
      const user = await admin.one<UserRow>(
        'select * from users where lower(username) = lower($1) and deleted_at is null',
        [username],
      );

      if (!user || !user.pin_hash) {
        throw unauthorized('That username or PIN is not correct.');
      }
      if (user.status === 'suspended') {
        throw forbiddenByPolicy('account_suspended', 'This account is suspended.');
      }
      assertNotLocked(user);

      const valid = await verifySecret(pin, user.pin_hash);
      if (!valid) {
        await recordFailure(user);
        throw unauthorized('That username or PIN is not correct.');
      }

      await admin.query(
        'update users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = $1',
        [user.id],
      );

      const deviceId = await resolveDevice(user, device);
      const bundle = await issueSession(user, deviceId, meta);

      await audit({
        farmId: user.farm_id,
        actorUserId: user.id,
        action: 'auth.login',
        recordType: 'user',
        recordId: user.id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });

      return bundle;
    },

    async refresh(refreshToken, meta) {
      const session = await admin.one<{
        id: string;
        farm_id: string;
        user_id: string;
        device_id: string | null;
        expires_at: unknown;
        revoked_at: unknown;
      }>(
        `select id, farm_id, user_id, device_id, expires_at, revoked_at
           from sessions
          where refresh_token_hash = $1`,
        [hashRefreshToken(refreshToken)],
      );

      if (!session || session.revoked_at) {
        throw unauthorized('Your session has ended. Sign in again.');
      }
      if (asDate(session.expires_at)!.getTime() <= Date.now()) {
        throw unauthorized('Your session has expired. Sign in again.');
      }

      const user = await admin.one<UserRow>('select * from users where id = $1', [
        session.user_id,
      ]);
      if (!user || user.status !== 'active') {
        throw unauthorized('This account is no longer active.');
      }

      // Rotate: the old token stops working the moment it is used.
      await admin.query('update sessions set revoked_at = now() where id = $1', [session.id]);

      const deviceId = session.device_id ?? (await resolveDevice(user, {}));
      return issueSession(user, deviceId, meta);
    },

    async logout(refreshToken) {
      await admin.query(
        'update sessions set revoked_at = now() where refresh_token_hash = $1 and revoked_at is null',
        [hashRefreshToken(refreshToken)],
      );
    },

    async profile(userId) {
      const user = await admin.one<UserRow>('select * from users where id = $1', [userId]);
      if (!user) throw notFound('Account not found.');

      const farm = await withTenant(app, user.farm_id, async (tx) =>
        tx.one<{ id: string; name: string; currency: string; offline_days_allowed: number }>(
          'select id, name, currency, offline_days_allowed from farms where id = $1',
          [user.farm_id],
        ),
      );

      return {
        user: toUserDto(user),
        permissions: await loadPermissions(user),
        farm: {
          id: farm?.id ?? user.farm_id,
          name: farm?.name ?? 'Farm',
          currency: farm?.currency ?? 'KES',
          offlineDaysAllowed: farm?.offline_days_allowed ?? 14,
        },
      };
    },

    async changePin(userId, currentPin, newPin) {
      const user = await admin.one<UserRow>('select * from users where id = $1', [userId]);
      if (!user) throw notFound('Account not found.');

      if (user.must_change_pin) {
        if (!currentPin) throw badRequest('current_pin_required', 'Enter the PIN you were given.');
        const valid = await verifySecret(currentPin, user.pin_hash);
        if (!valid) throw unauthorized('That PIN is not correct.');
      }

      const pinHash = await hashSecret(newPin);
      await admin.query(
        `update users
            set pin_hash = $2, must_change_pin = false, failed_attempts = 0, locked_until = null
          where id = $1`,
        [user.id, pinHash],
      );

      await audit({
        farmId: user.farm_id,
        actorUserId: user.id,
        action: 'auth.pin_changed',
        recordType: 'user',
        recordId: user.id,
      });
    },

    async createEmployee(actor, input, meta) {
      if (!actor.perms.includes('manage_accounts')) {
        throw forbidden('Only the farm owner can create accounts.');
      }
      if (input.role === 'owner') {
        throw badRequest('role_not_allowed', 'A farm has one owner.');
      }

      const phoneTaken = await admin.one<{ id: string }>(
        'select id from users where phone = $1 and deleted_at is null',
        [input.phone],
      );
      if (phoneTaken) throw conflict('phone_taken', 'That phone number is already in use.');

      const usernameTaken = await admin.one<{ id: string }>(
        'select id from users where lower(username) = lower($1) and deleted_at is null',
        [input.username],
      );
      if (usernameTaken) throw conflict('username_taken', 'That username is already in use.');

      const tempPin = generateTempPin();
      const pinHash = await hashSecret(tempPin);
      const employeeId = randomUUID();

      const row = await withTenant(app, actor.farm, async (tx: Db) => {
        return tx.one<UserRow>(
          `insert into users
             (id, farm_id, name, phone, username, role, pin_hash, must_change_pin)
           values ($1, $2, $3, $4, $5, $6, $7, true)
           returning *`,
          [
            employeeId,
            actor.farm,
            input.name,
            input.phone,
            input.username,
            input.role,
            pinHash,
          ],
        );
      });

      if (!row) throw new Error('Employee insert returned no row');

      await audit({
        farmId: actor.farm,
        actorUserId: actor.sub,
        action: 'account.created',
        recordType: 'user',
        recordId: employeeId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        after: { name: input.name, role: input.role, username: input.username },
      });

      return { user: toUserDto(row), tempPin };
    },

    async listEmployees(farmId) {
      const rows = await withTenant(app, farmId, async (tx) => {
        return tx.query<UserRow>(
          `select * from users
            where farm_id = $1 and role <> 'owner' and deleted_at is null
            order by created_at`,
          [farmId],
        );
      });
      return rows.map(toUserDto);
    },

    async setEmployeeStatus(actor, employeeId, status) {
      if (!actor.perms.includes('manage_accounts')) {
        throw forbidden('Only the farm owner can change accounts.');
      }

      const row = await withTenant(app, actor.farm, async (tx) => {
        return tx.one<UserRow>(
          `update users set status = $2
            where id = $1 and farm_id = $3 and role <> 'owner' and deleted_at is null
            returning *`,
          [employeeId, status, actor.farm],
        );
      });

      if (!row) throw notFound('Employee not found.');

      if (status === 'suspended') {
        // Cut every live session now; the phone learns at its next sync.
        await admin.query(
          'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
          [employeeId],
        );
      }

      await audit({
        farmId: actor.farm,
        actorUserId: actor.sub,
        action: status === 'suspended' ? 'account.suspended' : 'account.reactivated',
        recordType: 'user',
        recordId: employeeId,
      });

      return toUserDto(row);
    },

    async unlockEmployee(actor, employeeId) {
      if (!actor.perms.includes('manage_accounts')) {
        throw forbidden('Only the farm owner can unlock accounts.');
      }

      const row = await withTenant(app, actor.farm, async (tx) => {
        return tx.one<UserRow>(
          `update users set failed_attempts = 0, locked_until = null
            where id = $1 and farm_id = $2 and role <> 'owner' and deleted_at is null
            returning *`,
          [employeeId, actor.farm],
        );
      });

      if (!row) throw notFound('Employee not found.');

      await audit({
        farmId: actor.farm,
        actorUserId: actor.sub,
        action: 'account.unlocked',
        recordType: 'user',
        recordId: employeeId,
      });
    },
  };
}
