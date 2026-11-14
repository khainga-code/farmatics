import { randomUUID } from 'node:crypto';
import { openDatabase, runMigrations } from '@farmatics/db';
import { hashSecret } from '../auth/password.js';
import { generateTempPin } from '../auth/otp.js';
import { loadEnv } from './load-env.js';

loadEnv();

const OWNER_PHONE = '+254700000001';
const OWNER_PASSWORD = 'farmatics2026';
const EMPLOYEE_USERNAME = 'joseph';
const SALESPERSON_USERNAME = 'mercy';

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
    const salespersonId = randomUUID();
    const tempPin = generateTempPin();
    const salesPin = generateTempPin();

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
      await tx.query(
        `insert into users (id, farm_id, name, phone, username, role, pin_hash, must_change_pin)
         values ($1, $2, $3, $4, $5, 'salesperson', $6, true)`,
        [
          salespersonId,
          farmId,
          'Mercy Wanjiku',
          '+254700000003',
          SALESPERSON_USERNAME,
          await hashSecret(salesPin),
        ],
      );

      // A demo flock so the poultry and feed screens have something real to
      // show on first sign-in. Arrival is 20 days ago: the second vaccination
      // is due today and its reminder is already open.
      const houseId = randomUUID();
      const batchId = randomUUID();
      const feedId = randomUUID();

      await tx.query('insert into houses (id, farm_id, name, note) values ($1, $2, $3, $4)', [
        houseId,
        farmId,
        'House 1',
        'Demo brooder house',
      ]);
      await tx.query(
        `insert into batches
           (id, farm_id, house_id, code, breed, arrival_date, initial_count, note)
         values ($1, $2, $3, $4, $5, current_date - 20, $6, $7)`,
        [batchId, farmId, houseId, 'B-2026-01', 'Ross 308', 500, 'Demo batch'],
      );
      await tx.query(
        `insert into stock_items (id, farm_id, name, category, unit, reorder_level_kg)
         values ($1, $2, $3, 'feed', 'kg', $4)`,
        [feedId, farmId, 'Growers mash', 100],
      );
      await tx.query(
        `insert into stock_movements
           (id, farm_id, stock_item_id, kind, quantity_kg, note, recorded_at, recorded_by)
         values
           ($1, $2, $3, 'receipt', 750, 'Opening delivery', now() - interval '20 days', $4),
           ($5, $2, $3, 'issue', 120.5, 'First two weeks', now() - interval '6 days', $4)`,
        [randomUUID(), farmId, feedId, ownerId, randomUUID()],
      );
      await tx.query(
        `insert into mortality_events
           (id, farm_id, batch_id, count, cause, cause_category, recorded_at, recorded_by)
         values
           ($1, $2, $3, 4, 'Heat stress', 'heat', now() - interval '12 days', $4),
           ($5, $2, $3, 3, 'Gumboro suspected', 'disease', now() - interval '3 days', $4)`,
        [randomUUID(), farmId, batchId, ownerId, randomUUID()],
      );
      await tx.query(
        `insert into vaccination_events
           (id, farm_id, batch_id, day, note, recorded_at, recorded_by)
         values ($1, $2, $3, 12, 'Gumboro', now() - interval '8 days', $4)`,
        [randomUUID(), farmId, batchId, ownerId],
      );

      // Birds handed to the demo salesperson, so the Sales screen has data.
      const allocationId = randomUUID();
      await tx.query(
        `insert into sales_allocations
           (id, farm_id, batch_id, salesperson_id, count, note, recorded_at, recorded_by)
         values ($1, $2, $3, $4, 80, 'Demo allocation', now() - interval '2 days', $5)`,
        [allocationId, farmId, batchId, salespersonId, ownerId],
      );
      // Feed that went out with those birds, so the hand-over shows in kg too.
      await tx.query(
        `insert into stock_movements
           (id, farm_id, stock_item_id, kind, quantity_kg, batch_id, allocation_id, note, recorded_at, recorded_by)
         values ($1, $2, $3, 'issue', 60, $4, $5, 'Sent with the birds', now() - interval '2 days', $6)`,
        [randomUUID(), farmId, feedId, batchId, allocationId, ownerId],
      );

      // Money: one approved cost and one still waiting, so the finance screen
      // shows both states on first sign-in.
      const chickExpenseId = randomUUID();
      const transportExpenseId = randomUUID();

      await tx.query(
        `insert into expenses
           (id, farm_id, category, amount_kes, paid_to, method, batch_id, note, recorded_at, recorded_by)
         values
           ($1, $3, 'chicks', 18000, 'Kenya Feeds', 'cash', $4, 'Day-old chicks',
            now() - interval '20 days', $5),
           ($2, $3, 'transport', 2500, 'Boda rider', 'mpesa', $4, 'Chicks to the farm',
            now() - interval '18 days', $5)`,
        [chickExpenseId, transportExpenseId, farmId, batchId, ownerId],
      );
      await tx.query(
        `insert into expense_approvals
           (id, farm_id, expense_id, decision, note, recorded_at, recorded_by)
         values ($1, $2, $3, 'approved', 'Paid on delivery',
                 now() - interval '20 days', $4)`,
        [randomUUID(), farmId, chickExpenseId, ownerId],
      );
    });

    console.log('Demo farm created:');
    console.log(`  owner   ${OWNER_PHONE} / ${OWNER_PASSWORD}`);
    console.log(`  staff   ${EMPLOYEE_USERNAME} / ${tempPin} (must be changed at first sign-in)`);
    console.log(
      `  sales   ${SALESPERSON_USERNAME} / ${salesPin} (must be changed at first sign-in)`,
    );
  }
} finally {
  await db.close();
}
