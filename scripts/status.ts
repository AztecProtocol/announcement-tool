/**
 * Show what is configured and what happened recently.
 *
 *   npm run test:status
 */
import postgres from 'postgres';
import { loadEnv } from '../src/env.js';
loadEnv();

const DB = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const sql = postgres(DB, { max: 1 });

try {
  const destinations = await sql`select key, channel, config from channel_settings order by channel, key`;
  console.log('\nCHANNEL DESTINATIONS');
  console.log('====================');
  if (destinations.length === 0) console.log('(none — run: npm run setup:channel)');
  for (const d of destinations) {
    const cfg = d.config as Record<string, unknown>;
    const where = cfg.webhook_url ? String(cfg.webhook_url).slice(0, 45) + '…'
      : cfg.chat_id ? String(cfg.chat_id)
      : cfg.group_id ? String(cfg.group_id) : '(not set)';
    console.log(`${String(d.channel).padEnd(9)} ${String(d.key).padEnd(28)} -> ${where}`);
    console.log(`          networks: ${(cfg.networks as string[])?.join(', ')}   types: ${(cfg.types as string[])?.join(', ')}`);
    if (cfg.prefix) console.log(`          prefix: ${cfg.prefix}`);
  }

  const subs = await sql`select channel, endpoint, verified, filter_severities from subscriptions order by channel, endpoint`;
  console.log('\nSUBSCRIBERS');
  console.log('===========');
  if (subs.length === 0) console.log('(none — run: npm run test:subscriber -- you@example.com)');
  for (const s of subs) {
    console.log(`${String(s.channel).padEnd(9)} ${String(s.endpoint).padEnd(38)} ${s.verified ? 'verified' : 'NOT VERIFIED'}  severities: ${(s.filter_severities as string[]).join(',')}`);
  }

  const anns = await sql`select id, slug, type, severity, status, published_at from announcements
    order by created_at desc limit 5`;
  console.log('\nLAST 5 ANNOUNCEMENTS');
  console.log('====================');
  if (anns.length === 0) console.log('(none yet — run: npm run test:send)');
  for (const a of anns) {
    console.log(`${String(a.status).padEnd(18)} ${String(a.type).padEnd(11)} ${String(a.severity).padEnd(12)} ${a.slug}`);
  }

  const recent = await sql`select l.channel, l.target, l.status, l.attempts, l.last_error, a.slug
    from delivery_ledger l join announcements a on a.id = l.announcement_id and a.revision = l.revision
    order by l.next_attempt_at desc limit 15`;
  console.log('\nRECENT DELIVERIES (newest first)');
  console.log('================================');
  if (recent.length === 0) console.log('(none yet)');
  for (const r of recent) {
    const mark = r.status === 'delivered' ? '✓' : r.status === 'exhausted' ? '✗' : '·';
    console.log(`${mark} ${String(r.channel).padEnd(9)} ${String(r.target).padEnd(28)} ${String(r.status).padEnd(10)} attempts:${r.attempts}`);
    if (r.last_error) console.log(`    reason: ${String(r.last_error).slice(0, 120)}`);
  }

  const alerts = await sql`select key, notified_at from alert_state order by first_seen_at desc limit 5`;
  if (alerts.length) {
    console.log('\nHEALTH ALERTS RAISED');
    console.log('====================');
    for (const a of alerts) console.log(`${a.notified_at ? 'emailed ' : 'pending '} ${a.key}`);
  }
  console.log('');
} finally {
  await sql.end();
}
