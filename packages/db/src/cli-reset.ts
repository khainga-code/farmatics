import { loadEnv } from './env.js';
import { runMigrations } from './migrate.js';
import { openDatabase } from './open-database.js';
import { resetDatabase } from './reset.js';

loadEnv();

const database = openDatabase();

try {
  await resetDatabase(database.admin);
  const applied = await runMigrations(database.admin, { log: (m) => console.log(m) });
  console.log(`database reset, applied ${applied.length} migration(s)`);
} finally {
  await database.close();
}
