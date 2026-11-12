import type { FarmDto, Permission, UserDto } from '@farmatics/shared';
import type { FarmaticsDb, OfflineSession, PinVerifier } from './db.js';

/**
 * The offline session.
 *
 * A registered phone keeps a copy of who the user is, which permissions they
 * hold, and a PIN verifier. That lets a stock keeper open the app in a shed
 * with no signal, and it means the PIN never travels to the server on unlock.
 *
 * The verifier is a PBKDF2-SHA256 hash with a per-device salt. It gates the
 * local UI only - the server still re-checks every permission on sync, which
 * is the rule the plan requires.
 */

export const PBKDF2_ITERATIONS = 210_000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' },
    key,
    256,
  );

  return new Uint8Array(bits);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

export async function createPinVerifier(pin: string): Promise<PinVerifier> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, PBKDF2_ITERATIONS);
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    hash: toBase64(hash),
  };
}

export async function verifyPin(pin: string, verifier: PinVerifier): Promise<boolean> {
  if (verifier.algorithm !== 'PBKDF2-SHA256') return false;
  const derived = await derive(pin, fromBase64(verifier.salt), verifier.iterations);
  return equalBytes(derived, fromBase64(verifier.hash));
}

export interface SaveSessionInput {
  user: UserDto;
  farm: FarmDto;
  permissions: Permission[];
  deviceId: string;
  /**
   * Omit to keep the PIN already chosen on this phone. Pass `null` to clear it
   * (for example when the account is locked or signed out).
   */
  pinVerifier?: PinVerifier | null;
}

export async function saveSession(
  db: FarmaticsDb,
  input: SaveSessionInput,
  at: Date = new Date(),
): Promise<OfflineSession> {
  const existing = await db.session.get('current');

  const row: OfflineSession = {
    id: 'current',
    user: input.user,
    farm: input.farm,
    permissions: input.permissions,
    deviceId: input.deviceId,
    lastOnlineAt: at.toISOString(),
    pinVerifier:
      input.pinVerifier === undefined ? (existing?.pinVerifier ?? null) : input.pinVerifier,
  };

  await db.session.put(row);
  return row;
}

export async function loadSession(db: FarmaticsDb): Promise<OfflineSession | null> {
  return (await db.session.get('current')) ?? null;
}

export async function touchSession(db: FarmaticsDb, at: Date = new Date()): Promise<void> {
  const existing = await db.session.get('current');
  if (!existing) return;
  await db.session.put({ ...existing, lastOnlineAt: at.toISOString() });
}

export async function setPinVerifier(
  db: FarmaticsDb,
  pinVerifier: PinVerifier | null,
): Promise<void> {
  const existing = await db.session.get('current');
  if (!existing) return;
  await db.session.put({ ...existing, pinVerifier });
}

export async function clearSession(db: FarmaticsDb): Promise<void> {
  await db.session.delete('current');
}

/**
 * How long this phone may keep working without reaching the server.
 * The farm sets the limit; a phone with no session is never "fresh".
 */
export function offlineExpired(
  session: OfflineSession,
  at: Date = new Date(),
): boolean {
  const last = Date.parse(session.lastOnlineAt);
  if (Number.isNaN(last)) return true;
  const limitMs = Math.max(1, session.farm.offlineDaysAllowed) * 86_400_000;
  return at.getTime() - last > limitMs;
}

export type UnlockResult =
  | { ok: true; session: OfflineSession }
  | { ok: false; reason: 'no-session' | 'no-pin' | 'expired' | 'wrong-pin' };

export async function unlockSession(
  db: FarmaticsDb,
  pin: string,
  at: Date = new Date(),
): Promise<UnlockResult> {
  const session = await loadSession(db);
  if (!session) return { ok: false, reason: 'no-session' };
  if (!session.pinVerifier) return { ok: false, reason: 'no-pin' };
  if (offlineExpired(session, at)) return { ok: false, reason: 'expired' };

  const valid = await verifyPin(pin, session.pinVerifier);
  return valid ? { ok: true, session } : { ok: false, reason: 'wrong-pin' };
}
