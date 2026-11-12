import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { DatabaseContext } from '@farmatics/db';
import type { AppConfig } from './config.js';
import { createAuthenticate } from './auth/guard.js';
import { createAuthService } from './auth/service.js';
import { createSmsSender, type SmsSender } from './auth/sms.js';
import { AppError } from './errors.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerEmployeeRoutes } from './routes/employee.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerSyncRoutes } from './routes/sync.routes.js';
import { createSyncService } from './sync/service.js';

export interface BuildAppOptions {
  config: AppConfig;
  db: DatabaseContext;
  sms?: SmsSender;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = options;

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.isProduction ? 'info' : 'debug',
            redact: ['req.headers.authorization', 'req.body.password', 'req.body.pin'],
          },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  if (config.rateLimitEnabled) {
    await app.register(rateLimit, { global: false });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'rate_limited', message: 'Too many attempts. Wait a moment.' },
      });
    }

    request.log.error({ err: error }, 'unhandled request error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on our side.' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
    });
  });

  const sms = options.sms ?? createSmsSender(config.smsProvider);
  const service = createAuthService({ db, config, sms });
  const sync = createSyncService({ db });
  const authenticate = createAuthenticate(config.jwtSecret);

  registerHealthRoutes(app, db);

  await app.register(
    async (instance) => {
      registerAuthRoutes(instance, { service, config, authenticate });
      registerEmployeeRoutes(instance, { service, authenticate });
      registerSyncRoutes(instance, { service: sync, authenticate });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
