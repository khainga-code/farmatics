import type { FastifyInstance } from 'fastify';
import type { DatabaseContext } from '@farmatics/db';

export function registerHealthRoutes(app: FastifyInstance, db: DatabaseContext): void {
  app.get('/health', async () => ({
    status: 'ok',
    driver: db.driver,
    time: new Date().toISOString(),
  }));

  app.get('/health/db', async (_request, reply) => {
    try {
      await db.app.query('select 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
}
