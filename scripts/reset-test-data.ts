/**
 * Clear test announcements, deliveries and alerts. Keeps channel destinations
 * and subscribers so you don't have to set them up again.
 *
 *   npm run test:reset            # clear announcements/deliveries/alerts
 *   npm run test:reset -- --all   # also clear destinations and subscribers
 */
import { loadEnv } from '../src/env.js';
loadEnv();
import { connect, dbEnvFromProcessEnv } from '../src/db/connect.js';

const all = process.argv.includes('--all');
const sql = connect(dbEnvFromProcessEnv(), 1);

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
