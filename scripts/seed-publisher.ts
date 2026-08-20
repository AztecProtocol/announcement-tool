/**
 * Add one publisher (idempotent), the fix named by the production startup
 * check in src/core/identity.ts when the publishers table is empty.
 *
 *   npm run seed:publisher -- you@example.com
 */
import postgres from 'postgres';
import { loadEnv } from '../src/env.js';
loadEnv();

const DB = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const email = process.argv[2];

if (!email) {
  console.error('\nUsage: npm run seed:publisher -- you@example.com\n');
  process.exit(1);
}

if (!email.includes('@')) {
  console.error(`\n"${email}" does not look like an email address. Refusing.\n`);
  process.exit(1);
}

const sql = postgres(DB, { max: 1 });
try {
  await sql`insert into publishers (email) values (${email}) on conflict do nothing`;
  const rows = await sql`select email from publishers order by email`;
  console.log(`\nPublishers (${rows.length}):`);
  for (const r of rows) console.log(`  - ${r.email as string}`);
  console.log();
} finally {
  await sql.end();
}
