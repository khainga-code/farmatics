import { randomUUID } from 'node:crypto';
import { openDatabase, runMigrations } from '@farmatics/db';
import { hashSecret } from '../auth/password.js';
import { generateTempPin } from '../auth/otp.js';
import { loadEnv } from './load-env.js';

loadEnv();

const OWNER_PHONE = '+254700000001';
const OWNER_PASSWORD = 'farmatics2026';
const EMPLOYEE_USERNAME = 'joseph';

const db = openDatabase();

try {
  await runMigrations(db.admin, { log: (m) => console.log(`[db] ${m}`) });

  const existing = await db.admin.one<{ id: string }>(
    "select id from farms where name = $1 and deleted_at is null",
    ['D Ayo Farm'],
  );

  if (existing) {
    console.log('Demo farm already present. Run `pnpm db:reset` first for a clean slate.');
  } else {
    const farmId = randomUUID();
    const ownerId = randomUUID();
    const employeeId = randomUUID();
    const tempPin = generateTempPin();

    await db.admin.transaction(async (tx) => {
      await tx.query('select set_config($1, $2, true)', ['app.farm_id', farmId]);
      await tx.query('insert into farms (id, name) values ($1, $2)', [farmId, 'D Ayo Farm']);
      await tx.query(
        `insert into users (id, farm_id, name, phone, role, password_hash)
         values ($1, $2, $3, $4, 'owner', $5)`,
        [ownerId, farmId, 'Samuel Khainga', OWNER_PHONE, await hashSecret(OWNER_PASSWORD)],
      );
      await tx.query(
        `insert into users (id, farm_id, name, phone, username, role, pin_hash, must_change_pin)
         values ($1, $2, $3, $4, $5, 'stock_keeper', $6, true)`,
        [
          employeeId,
          farmId,
          'Joseph Mwangi',
          '+254700000002',
          EMPLOYEE_USERNAME,
          await hashSecret(tempPin),
        ],
      );
    });

    console.log('Demo farm created:');
    console.log(`  owner   ${OWNER_PHONE} / ${OWNER_PASSWORD}`);
    console.log(`  staff   ${EMPLOYEE_USERNAME} / ${tempPin} (must be changed at first sign-in)`);
  }
} finally {
  await db.close();
}
