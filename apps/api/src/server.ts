import { openDatabase, runMigrations } from '@farmatics/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSmsSender } from './auth/sms.js';

const config = loadConfig();
const db = openDatabase();

// Local development runs migrations on boot because the embedded database is
// held by a single process. Production migrations are an explicit step.
if (!config.isProduction || process.env['AUTO_MIGRATE'] === 'true') {
  const applied = await runMigrations(db.admin, { log: (m) => console.log(`[db] ${m}`) });
  if (applied.length === 0) console.log('[db] up to date');
}

if (
  config.isProduction &&
  db.driver === 'postgres' &&
  process.env['DATABASE_URL'] &&
  process.env['DATABASE_URL'] === process.env['DATABASE_ADMIN_URL']
) {
  console.warn(
    '[security] DATABASE_URL and DATABASE_ADMIN_URL are the same. ' +
      'Row level security will NOT protect farm data. Point DATABASE_URL at farmatics_app.',
  );
}

const app = await buildApp({ config, db, sms: createSmsSender(config.smsProvider) });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
app.log.info(
  `Farmatics API listening on http://localhost:${config.port} (database: ${db.driver})`,
);
