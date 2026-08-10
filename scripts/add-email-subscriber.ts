/**
 * Add (and immediately verify) one email subscriber, for testing.
 *
 *   npm run test:subscriber -- you@example.com
 *   npm run test:subscriber -- you@example.com --criticals-only
 *
 * Real subscribers confirm by clicking a link (that flow is Plan 3). This helper
 * marks the address verified directly so the email channel can be tested now.
 */
import postgres from 'postgres';
import { createSubscription, verifySubscription } from '../src/core/subscriptions.js';

const DB = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const args = process.argv.slice(2);
const email = args.find(a => a.includes('@'));
const criticalsOnly = args.includes('--criticals-only');

if (!email) {
  console.error('\nUsage: npm run test:subscriber -- you@example.com [--criticals-only]\n');
  process.exit(1);
}

const sql = postgres(DB, { max: 1 });
try {
  const existing = await sql`select id from subscriptions where channel = 'email' and endpoint = ${email}`;
  if (existing[0]) {
    await verifySubscription(sql, existing[0].id as string);
    console.log(`\n✓ ${email} was already subscribed — it is now marked verified.\n`);
  } else {
    const sub = await createSubscription(sql, {
      channel: 'email',
      endpoint: email,
      filters: criticalsOnly ? { severities: ['critical'] } : undefined,
    });
    await verifySubscription(sql, sub.id);
    console.log(`\n✓ Subscribed ${email} (verified).`);
    console.log(`  Receives: ${criticalsOnly ? 'critical announcements only' : 'all severities'}`);
    console.log(`  Unsubscribe token: ${sub.unsubscribeToken}\n`);
  }
} finally {
  await sql.end();
}
