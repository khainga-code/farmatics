import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  changePinSchema,
  loginSchema,
  registerFarmSchema,
  staffLoginSchema,
  verifyOtpSchema,
  refreshSchema,
} from '@farmatics/shared';
import type { AppConfig } from '../config.js';
import { parseBody } from '../validation.js';
import { tooManyRequests } from '../errors.js';
import { requireAuth, type Authenticate } from '../auth/guard.js';
import type { AuthService, RequestMeta } from '../auth/service.js';
import {
  AUTH_THROTTLE_LIMITS,
  createAccountThrottle,
  type AccountThrottle,
} from '../auth/throttle.js';

function metaFrom(request: FastifyRequest): RequestMeta {
  return { ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null };
}

function guard(limiter: AccountThrottle, key: string): void {
  if (limiter.consume(key)) return;
  const retryAfter = limiter.retryAfterSeconds(key);
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  throw tooManyRequests(
    'rate_limited',
    `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfter },
  );
}

type ThrottleName = 'register' | 'verify' | 'login' | 'staffLogin';

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { service: AuthService; config: AppConfig; authenticate: Authenticate },
): void {
  const { service, config, authenticate } = deps;

  // The per-IP limit on these routes is load-bearing but blind to the account
  // being tried. These count attempts per phone or username, so a fresh IP is
  // no help.
  const throttles = config.rateLimitEnabled
    ? {
        register: createAccountThrottle(AUTH_THROTTLE_LIMITS.register),
        verify: createAccountThrottle(AUTH_THROTTLE_LIMITS.verify),
        login: createAccountThrottle(AUTH_THROTTLE_LIMITS.login),
        staffLogin: createAccountThrottle(AUTH_THROTTLE_LIMITS.staffLogin),
      }
    : null;

  function check(name: ThrottleName, key: string): void {
    if (throttles) guard(throttles[name], key);
  }

  function clear(name: ThrottleName, key: string): void {
    throttles?.[name].reset(key);
  }

  app.post(
    '/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = parseBody(registerFarmSchema, request.body);
      check('register', input.phone);
      const result = await service.registerFarm(input, metaFrom(request));
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/auth/verify',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = parseBody(verifyOtpSchema, request.body);
      check('verify', input.phone);
      const bundle = await service.verifyRegistration(
        input.phone,
        input.code,
        {
          deviceLabel: (request.body as { deviceLabel?: string })?.deviceLabel,
          platform: (request.body as { platform?: string })?.platform,
        },
        metaFrom(request),
      );
      return reply.status(201).send(bundle);
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request) => {
      const input = parseBody(loginSchema, request.body);
      check('login', input.phone);
      const bundle = await service.loginWithPassword(
        input.phone,
        input.password,
        input,
        metaFrom(request),
      );
      clear('login', input.phone);
      return bundle;
    },
  );

  app.post(
    '/auth/staff-login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request) => {
      const input = parseBody(staffLoginSchema, request.body);
      check('staffLogin', input.username);
      const bundle = await service.loginWithPin(
        input.username,
        input.pin,
        input,
        metaFrom(request),
      );
      clear('staffLogin', input.username);
      return bundle;
    },
  );

  app.post('/auth/refresh', async (request) => {
    const input = parseBody(refreshSchema, request.body);
    return service.refresh(input.refreshToken, metaFrom(request));
  });

  app.post('/auth/logout', async (request, reply) => {
    const input = parseBody(refreshSchema, request.body);
    await service.logout(input.refreshToken);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: authenticate }, async (request) => {
    const claims = requireAuth(request);
    return service.profile(claims.sub);
  });

  app.post('/auth/pin', { preHandler: authenticate }, async (request, reply) => {
    const claims = requireAuth(request);
    const input = parseBody(changePinSchema, request.body);
    await service.changePin(claims.sub, input.currentPin, input.newPin);
    return reply.status(204).send();
  });
}
