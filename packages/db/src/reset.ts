import type { Db } from './client.js';

/**
 * Drops every application object and rebuilds from the migrations.
 * Refuses to run unless NODE_ENV is development or test.
 */
export async function resetDatabase(db: Db): Promise<void> {
  const env = process.env['NODE_ENV'] ?? 'development';
  if (env !== 'development' && env !== 'test') {
    throw new Error(`resetDatabase refuses to run with NODE_ENV=${env}`);
  }

  await db.exec(`
    drop schema if exists farmatics_meta cascade;
    drop schema if exists public cascade;
    create schema public;
  `);
}
