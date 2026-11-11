import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';
import { splitStatements } from './sql-split.js';

const DEFAULT_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface MigrateOptions {
  dir?: string;
  log?: (message: string) => void;
}

/**
 * Applies pending .sql files in filename order. Each file runs in its own
 * transaction and is recorded so it never runs twice.
 */
export async function runMigrations(db: Db, options: MigrateOptions = {}): Promise<string[]> {
  const dir = options.dir ?? DEFAULT_DIR;
  const log = options.log ?? (() => {});

  await db.exec(`
    create schema if not exists farmatics_meta;
    create table if not exists farmatics_meta.migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const applied = new Set(
    (await db.query<{ name: string }>('select name from farmatics_meta.migrations')).map(
      (row) => row.name,
    ),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sqlText = await readFile(join(dir, file), 'utf8');
    const statements = splitStatements(sqlText);

    await db.transaction(async (tx) => {
      for (const statement of statements) {
        await tx.exec(statement);
      }
      await tx.query('insert into farmatics_meta.migrations (name) values ($1)', [file]);
    });

    ran.push(file);
    log(`applied ${file} (${statements.length} statements)`);
  }

  return ran;
}
