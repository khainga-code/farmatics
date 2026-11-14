/**
 * Per-account throttling for the sign-in endpoints.
 *
 * The HTTP rate limit counts requests per IP. That stops one machine hammering
 * the door, but a distributed guess costs a fresh IP per attempt, so the same
 * password can be tried against one account from anywhere. This limiter counts
 * attempts per account instead, independent of where they come from.
 *
 * It is a sliding window in process memory: small, exact, and good enough for
 * the single API process the pilot runs. A multi-instance deployment needs a
 * shared store (Redis or the database) in front of the same interface.
 */

export interface AccountThrottle {
  /** Records an attempt. Returns false when the key has used up its window. */
  consume(key: string): boolean;
  /** Forgets a key, called after a successful sign-in. */
  reset(key: string): void;
  /** Whole seconds until the oldest attempt leaves the window (0 when open). */
  retryAfterSeconds(key: string): number;
}

export interface AccountThrottleOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

/** Loose bound on distinct identifiers held between sweeps. */
const MAX_KEYS = 5_000;

export function createAccountThrottle(options: AccountThrottleOptions): AccountThrottle {
  const { max, windowMs, now = Date.now } = options;
  const attempts = new Map<string, number[]>();

  function live(key: string): number[] {
    const cutoff = now() - windowMs;
    const recent = (attempts.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) attempts.delete(key);
    else attempts.set(key, recent);
    return recent;
  }

  function sweep(): void {
    for (const key of attempts.keys()) live(key);
  }

  return {
    consume(key) {
      const recent = live(key);
      if (recent.length >= max) return false;
      if (attempts.size >= MAX_KEYS) sweep();
      recent.push(now());
      attempts.set(key, recent);
      return true;
    },

    reset(key) {
      attempts.delete(key);
    },

    retryAfterSeconds(key) {
      const recent = live(key);
      if (recent.length < max) return 0;
      const oldest = recent[0]!;
      return Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000));
    },
  };
}

/**
 * Limits chosen so a person who mistypes a few times is never stopped, but a
 * guesser is. Login also locks the account after five failures; this ceiling
 * covers the window around that lock and repeats across IPs.
 */
export const AUTH_THROTTLE_LIMITS = {
  register: { max: 3, windowMs: 60 * 60_000 },
  verify: { max: 10, windowMs: 15 * 60_000 },
  login: { max: 10, windowMs: 15 * 60_000 },
  staffLogin: { max: 10, windowMs: 15 * 60_000 },
} as const;

export type AuthThrottleKind = keyof typeof AUTH_THROTTLE_LIMITS;
