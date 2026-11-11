import { loadEnv } from './env.js';
import { runMigrations } from './migrate.js';
import { openDatabase } from './open-database.js';

loadEnv();

const database = openDatabase();

try {
  const applied = await runMigrations(database.admin, { log: (m) => console.log(m) });
  if (applied.length === 0) console.log('database is up to date');
  else console.log(`applied ${applied.length} migration(s)`);
} finally {
  await database.close();
}
