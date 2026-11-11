import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Permission, Role } from '@farmatics/shared';

export interface AccessClaims {
  /** user id */
  sub: string;
  /** farm id */
  farm: string;
  role: Role;
  perms: Permission[];
  /** session id, so a single session can be revoked */
  sid: string;
  /** device id, so a single phone can be cut off */
  dev: string | null;
  iat: number;
  exp: number;
  typ: 'access';
}

const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * HS256 JWT. Kept hand-rolled so the claim shape is explicit - it is what the
 * offline session bundle on each phone will hold.
 */
export function signAccessToken(
  claims: Omit<AccessClaims, 'iat' | 'exp' | 'typ'>,
  secret: string,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
    typ: 'access',
  };
  const body = `${HEADER}.${base64url(JSON.stringify(payload))}`;
  return `${body}.${sign(body, secret)}`;
}

export function verifyAccessToken(token: string, secret: string): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const [header, payload, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${header}.${payload}`, secret));
  const actual = Buffer.from(signature);

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('bad signature');
  }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessClaims;

  if (claims.typ !== 'access') throw new Error('wrong token type');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new Error('expired');
  }

  return claims;
}

export function createRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Refresh tokens are stored hashed, so a database leak cannot be replayed. */
export function hashRefreshToken(token: string): string {
  return createHmac('sha256', 'farmatics-refresh').update(token).digest('hex');
}
