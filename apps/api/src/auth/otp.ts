import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Six digits, from the cryptographic generator. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * The code is bound to the phone number and hashed with the server secret, so
 * the stored value is useless without both.
 */
export function hashOtp(phone: string, code: string, secret: string): string {
  return createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
}

export function otpMatches(
  phone: string,
  code: string,
  storedHash: string,
  secret: string,
): boolean {
  const expected = Buffer.from(hashOtp(phone, code, secret), 'hex');
  const actual = Buffer.from(storedHash, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** A temporary PIN a new employee must change at first sign-in. */
export function generateTempPin(): string {
  return String(randomInt(100_000, 1_000_000));
}
