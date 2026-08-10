/**
 * Clear test announcements, deliveries and alerts. Keeps channel destinations
 * and subscribers so you don't have to set them up again.
 *
 *   npm run test:reset            # clear announcements/deliveries/alerts
 *   npm run test:reset -- --all   # also clear destinations and subscribers
 */
import postgres from 'postgres';

const DB = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const all = process.argv.includes('--all');
const sql = postgres(DB, { max: 1 });

try {
  await sql`delete from delivery_ledger`;
  await sql`delete from alert_state`;
  await sql`delete from announcements`;
  await sql`delete from audit_log`;
  console.log('\n✓ Cleared announcements, deliveries, alerts and the audit log.');
  if (all) {
    await sql`delete from channel_settings`;
    await sql`delete from subscriptions`;
    console.log('✓ Also cleared channel destinations and subscribers.');
  } else {
    console.log('  (Channel destinations and subscribers kept — use --all to clear those too.)');
  }
  console.log('');
} finally {
  await sql.end();
}
