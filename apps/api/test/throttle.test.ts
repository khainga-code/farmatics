import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { TokenBundle } from '@farmatics/shared';
import { createAccountThrottle } from '../src/auth/throttle.js';
import type { AuthService } from '../src/auth/service.js';
import { loadConfig } from '../src/config.js';
import { AppError, unauthorized } from '../src/errors.js';
import { registerAuthRoutes } from '../src/routes/auth.routes.js';

/**
 * The IP limit is blind to which account is being tried. These tests pin the
 * account-keyed window that sits beside it: attempts are counted per phone or
 * username, a rejected attempt does not extend the window, and one account
 * never spends another's budget.
 */

function throttleAt(start = 1_000_000, max = 3, windowMs = 60_000) {
  let time = start;
  const throttle = createAccountThrottle({ max, windowMs, now: () => time });
  return {
    throttle,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe('account throttle', () => {
  it('allows the limit and refuses the next attempt', () => {
    const { throttle } = throttleAt();
    expect(throttle.consume('+254700000001')).toBe(true);
    expect(throttle.consume('+254700000001')).toBe(true);
    expect(throttle.consume('+254700000001')).toBe(true);
    expect(throttle.consume('+254700000001')).toBe(false);
  });

  it('reopens once the oldest attempt leaves the window', () => {
    const { throttle, advance } = throttleAt();
    throttle.consume('a');
    throttle.consume('a');
    throttle.consume('a');

    advance(59_999);
    expect(throttle.consume('a')).toBe(false);

    advance(1);
    expect(throttle.consume('a')).toBe(true);
  });

  it('does not let a rejected attempt extend the block', () => {
    const { throttle, advance } = throttleAt();
    for (let attempt = 0; attempt < 10; attempt += 1) throttle.consume('a');

    advance(30_000);
    expect(throttle.consume('a')).toBe(false);

    advance(30_000);
    expect(throttle.consume('a')).toBe(true);
  });

  it('reports whole seconds until the window opens', () => {
    const { throttle, advance } = throttleAt();
    throttle.consume('a');
    throttle.consume('a');
    throttle.consume('a');

    expect(throttle.retryAfterSeconds('a')).toBe(60);
    advance(20_500);
    expect(throttle.retryAfterSeconds('a')).toBe(40);
    expect(throttle.retryAfterSeconds('never-tried')).toBe(0);
  });

  it('forgets a key on reset, as a successful sign-in should', () => {
    const { throttle } = throttleAt();
    throttle.consume('a');
    throttle.consume('a');
    throttle.consume('a');
    throttle.reset('a');

    expect(throttle.consume('a')).toBe(true);
  });

  it('keeps one account out of another account’s budget', () => {
    const { throttle } = throttleAt();
    for (let attempt = 0; attempt < 4; attempt += 1) throttle.consume('owner');

    expect(throttle.consume('worker')).toBe(true);
  });
});

describe('throttling on the sign-in route', () => {
  it('limits one phone across addresses, clears on success and reports a retry', async () => {
    const app = Fastify();
    const service = {
      async loginWithPassword(_phone: string, password: string) {
        if (password !== 'right') throw unauthorized('That number or password is not correct.');
        return {
          accessToken: 'access',
          refreshToken: 'refresh',
          accessTokenExpiresIn: 900,
          deviceId: null,
          user: {},
          permissions: [],
        } as unknown as TokenBundle;
      },
    } as unknown as AuthService;

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      return reply.send(error);
    });

    registerAuthRoutes(app, {
      service,
      config: loadConfig({
        rateLimitEnabled: true,
        jwtSecret: 'test-secret-that-is-long-enough-for-hashing',
      }),
      authenticate: async () => {},
    });
    await app.ready();

    const attempt = (phone: string, password: string, address: string) =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { phone, password },
        remoteAddress: address,
      });

    for (let count = 0; count < 3; count += 1) {
      const response = await attempt('0700000009', 'wrong', `203.0.113.${count + 1}`);
      expect(response.statusCode).toBe(401);
    }

    // A good sign-in clears the window, so earlier typos do not count.
    expect((await attempt('0700000009', 'right', '203.0.113.50')).statusCode).toBe(200);

    for (let count = 0; count < 10; count += 1) {
      const response = await attempt('0700000009', 'wrong', `198.51.100.${count + 1}`);
      expect(response.statusCode).toBe(401);
    }

    const blocked = await attempt('0700000009', 'wrong', '192.0.2.77');
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json() as {
      error: { code: string; details: { retryAfter: number } };
    };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details.retryAfter).toBeGreaterThan(0);

    // Another number from the blocked address still has its own budget.
    expect((await attempt('0700000010', 'wrong', '192.0.2.77')).statusCode).toBe(401);

    await app.close();
  });
});
