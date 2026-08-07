import postgres, { type Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';

export const TEST_DB_URL =
  process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';

let migrated = false;

export async function testSql(): Promise<Sql> {
  if (!migrated) { await migrate(TEST_DB_URL); migrated = true; }
  // Always return a fresh connection pool (tests close them in afterAll)
  // This avoids transaction isolation issues when multiple test files run
  return postgres(TEST_DB_URL, { max: 4 });
}
export async function resetDb(sql: Sql): Promise<void> {
  await sql`truncate announcements, subscriptions, delivery_ledger, audit_log, channel_settings restart identity`;
}
