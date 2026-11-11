import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createEmployeeSchema } from '@farmatics/shared';
import { parseBody } from '../validation.js';
import { requireAuth, type Authenticate } from '../auth/guard.js';
import type { AuthService, RequestMeta } from '../auth/service.js';

export function registerEmployeeRoutes(
  app: FastifyInstance,
  deps: { service: AuthService; authenticate: Authenticate },
): void {
  const { service, authenticate } = deps;

  const metaFrom = (request: FastifyRequest): RequestMeta => ({
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  });

  app.get('/employees', { preHandler: authenticate }, async (request) => {
    const claims = requireAuth(request);
    return { employees: await service.listEmployees(claims.farm) };
  });

  app.post('/employees', { preHandler: authenticate }, async (request, reply) => {
    const claims = requireAuth(request);
    const input = parseBody(createEmployeeSchema, request.body);
    const result = await service.createEmployee(claims, input, metaFrom(request));
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string } }>(
    '/employees/:id/suspend',
    { preHandler: authenticate },
    async (request) => {
      const claims = requireAuth(request);
      return { employee: await service.setEmployeeStatus(claims, request.params.id, 'suspended') };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/employees/:id/reactivate',
    { preHandler: authenticate },
    async (request) => {
      const claims = requireAuth(request);
      return { employee: await service.setEmployeeStatus(claims, request.params.id, 'active') };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/employees/:id/unlock',
    { preHandler: authenticate },
    async (request, reply) => {
      const claims = requireAuth(request);
      await service.unlockEmployee(claims, request.params.id);
      return reply.status(204).send();
    },
  );
}
