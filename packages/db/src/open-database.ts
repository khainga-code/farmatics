import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Db } from './client.js';
import { createPgliteDb } from './pglite-driver.js';
import { createPgDb } from './pg-driver.js';

const isPostgresUrl = (value: string | undefined): value is string =>
  typeof value === 'string' && /^postgres(ql)?:\/\//.test(value.trim());

/** Finds the workspace root so a relative DATABASE_DIR lands in one place. */
function workspaceRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export interface DatabaseContext {
  /** RLS-restricted connection. Use for every request that touches farm data. */
  app: Db;
  /** Owner connection. Migrations, seeding and the auth module only. */
  admin: Db;
  driver: 'postgres' | 'embedded';
  close(): Promise<void>;
}

export interface OpenDatabaseConfig {
  databaseUrl?: string | undefined;
  adminUrl?: string | undefined;
  dataDir?: string | undefined;
}

/**
 * Opens the database described by the environment.
 *
 * With no Postgres URL configured this runs embedded Postgres on disk, which
 * is what local development uses. There is only one connection, so admin and
 * app are the same handle.
 */
export function openDatabase(config: OpenDatabaseConfig = {}): DatabaseContext {
  const appUrl = config.databaseUrl ?? process.env['DATABASE_URL'];
  const adminUrl = config.adminUrl ?? process.env['DATABASE_ADMIN_URL'];

  const url = isPostgresUrl(adminUrl) ? adminUrl : isPostgresUrl(appUrl) ? appUrl : undefined;

  if (url) {
    const admin = createPgDb(url, { max: 4 });
    const app = isPostgresUrl(appUrl) ? createPgDb(appUrl, { max: 10 }) : admin;
    return {
      app,
      admin,
      driver: 'postgres',
      async close() {
        if (app !== admin) await app.close();
        await admin.close();
      },
    };
  }

  const configuredDir = config.dataDir ?? process.env['DATABASE_DIR'] ?? '.data/pg';
  const dataDir = isAbsolute(configuredDir)
    ? configuredDir
    : resolve(workspaceRoot(), configuredDir);

  const db = createPgliteDb(dataDir);
  return {
    app: db,
    admin: db,
    driver: 'embedded',
    async close() {
      await db.close();
    },
  };
}
