import type { FastifyInstance } from 'fastify';
import { syncPullQuerySchema, syncPushRequestSchema } from '@farmatics/shared';
import { parseBody } from '../validation.js';
import { requireAuth, type Authenticate } from '../auth/guard.js';
import type { SyncService } from '../sync/service.js';

export function registerSyncRoutes(
  app: FastifyInstance,
  deps: { service: SyncService; authenticate: Authenticate },
): void {
  const { service, authenticate } = deps;

  app.post('/sync/push', { preHandler: authenticate }, async (request) => {
    const claims = requireAuth(request);
    const body = parseBody(syncPushRequestSchema, request.body);
    return service.push(claims, body.records);
  });

  app.get('/sync/pull', { preHandler: authenticate }, async (request) => {
    const claims = requireAuth(request);
    const query = parseBody(syncPullQuerySchema, request.query ?? {});
    return service.pull(claims, query.cursor ?? '0', query.limit ?? 100);
  });
}
