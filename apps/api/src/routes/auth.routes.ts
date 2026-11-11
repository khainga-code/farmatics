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
import { requireAuth, type Authenticate } from '../auth/guard.js';
import type { AuthService, RequestMeta } from '../auth/service.js';

function metaFrom(request: FastifyRequest): RequestMeta {
  return { ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { service: AuthService; config: AppConfig; authenticate: Authenticate },
): void {
  const { service, authenticate } = deps;

  app.post(
    '/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = parseBody(registerFarmSchema, request.body);
      const result = await service.registerFarm(input, metaFrom(request));
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/auth/verify',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = parseBody(verifyOtpSchema, request.body);
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
      return service.loginWithPassword(input.phone, input.password, input, metaFrom(request));
    },
  );

  app.post(
    '/auth/staff-login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request) => {
      const input = parseBody(staffLoginSchema, request.body);
      return service.loginWithPin(input.username, input.pin, input, metaFrom(request));
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
