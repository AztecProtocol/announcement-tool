/**
 * Publish one realistic test announcement and deliver it to every configured channel.
 *
 *   npm run test:send                 # critical mainnet upgrade (the common case)
 *   npm run test:send -- --governance # a governance announcement instead
 *   npm run test:send -- --info       # a low-severity info notice
 *
 * Runs the real publish path (draft -> request -> four-eyes confirm -> fan-out),
 * then drains the delivery queue once and prints what each channel did.
 */
import postgres from 'postgres';
import { loadEnv } from '../src/env.js';
loadEnv();
import { createDraft, requestPublish, confirmPublish } from '../src/core/announcements.js';
import { runFanoutOnce } from '../src/worker/fanout.js';
import { senderFromEnv } from '../src/adapters/esp.js';
import { makeWebhookAdapter } from '../src/adapters/webhook.js';
import { makeDiscordAdapter } from '../src/adapters/discord.js';
import { makeTelegramAdapter } from '../src/adapters/telegram.js';
import { makeEmailAdapter } from '../src/adapters/email.js';
import { makeSignalAdapter } from '../src/adapters/signal.js';
import type { ChannelAdapter } from '../src/adapters/types.js';
import type { AnnouncementInput } from '../src/core/types.js';

const DB = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const flags = process.argv.slice(2);

const deadline = new Date(Date.now() + 12 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const UPGRADE: AnnouncementInput = {
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: `TEST — Upgrade to v5.1.0 required by ${deadline.slice(0, 16).replace('T', ' ')} UTC`,
  bodyMd: 'This is a **test announcement** from the announcement pipeline. It is not a real upgrade notice.\n\nSequencers and provers on mainnet would normally need to upgrade before the deadline below.',
  actionsRequired: [{ action: 'Upgrade node to v5.1.0', deadline, applies_to: ['sequencer', 'prover'] }],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
  expiresAt: deadline,
};

const GOVERNANCE: AnnouncementInput = {
  type: 'governance', networks: ['mainnet'], audiences: ['operators'], severity: 'recommended',
  title: 'TEST — AZIP-7 signaling window is open',
  bodyMd: 'This is a **test announcement** from the announcement pipeline. It is not a real governance notice.\n\nSignaling would normally be open for one week.',
  actionsRequired: [{ action: 'Signal on AZIP-7 if you wish to participate', deadline, applies_to: ['sequencer'] }],
  links: [{ label: 'Proposal', url: 'https://forum.aztec.network/' }],
};

const INFO: AnnouncementInput = {
  type: 'info', networks: ['mainnet'], audiences: ['operators'], severity: 'info',
  title: 'TEST — Upgrade executed successfully',
  bodyMd: 'This is a **test announcement** from the announcement pipeline. No action is required.',
  actionsRequired: [], links: [],
};

const input = flags.includes('--governance') ? GOVERNANCE : flags.includes('--info') ? INFO : UPGRADE;

async function main(): Promise<void> {
  const sql = postgres(DB, { max: 4 });
  const sender = senderFromEnv();
  const adapters: Record<string, ChannelAdapter> = {
    webhook: makeWebhookAdapter(sql),
    discord: makeDiscordAdapter(sql),
    telegram: makeTelegramAdapter(sql),
    email: makeEmailAdapter(sql, sender),
    signal: makeSignalAdapter(sql),
  };

  try {
    const destinations = await sql`select key, channel from channel_settings order by key`;
    const subs = await sql`select id, channel, endpoint, verified from subscriptions order by channel, endpoint`;
    console.log(`\nEmail provider: ${sender.name}`);
    console.log(`Channel destinations configured: ${destinations.length}`);
    for (const d of destinations) console.log(`  - ${d.key}  (${d.channel})`);
    console.log(`Subscribers: ${subs.length}`);
    for (const s of subs) console.log(`  - ${s.channel}: ${s.endpoint} ${s.verified ? '(verified)' : '(NOT verified — will be skipped)'}`);
    if (destinations.length === 0 && subs.length === 0) {
      console.log('\n✗ Nothing is configured yet. Run: npm run setup:channel\n');
      return;
    }

    console.log(`\nPublishing a ${input.severity} ${input.type} announcement…`);
    const draft = await createDraft(sql, input, 'tester-one@aztec.foundation');
    const requested = await requestPublish(sql, draft.id, 'tester-one@aztec.foundation');
    // Four-eyes applies to critical only: a critical announcement waits for a second
    // publisher; recommended/info publish immediately on request.
    const published = requested.status === 'publish_requested'
      ? await confirmPublish(sql, draft.id, 'tester-two@aztec.foundation')
      : requested;
    console.log(requested.status === 'publish_requested'
      ? `✓ Published ${published.id} (four-eyes: requested by tester-one, confirmed by tester-two)`
      : `✓ Published ${published.id} (${input.severity} severity — no second confirmation needed, by design)`);
    console.log(`  Public page would be: /a/${published.slug}`);

    const queued = await sql`select channel, target from delivery_ledger
      where announcement_id = ${published.id} order by channel, target`;
    console.log(`\nQueued ${queued.length} deliveries:`);
    for (const q of queued) console.log(`  - ${q.channel} -> ${q.target}`);

    console.log('\nDelivering…');
    const result = await runFanoutOnce(sql, adapters, 100);
    console.log(`Attempted: ${result.delivered} delivered, ${result.failed} failed\n`);

    const rows = await sql`select channel, target, status, attempts, last_error from delivery_ledger
      where announcement_id = ${published.id} order by channel, target`;
    console.log('Result per destination');
    console.log('----------------------');
    for (const r of rows) {
      const mark = r.status === 'delivered' ? '✓' : '✗';
      console.log(`${mark} ${String(r.channel).padEnd(9)} ${String(r.target).padEnd(28)} ${r.status}`);
      if (r.last_error) console.log(`    reason: ${r.last_error}`);
    }
    const failed = rows.filter(r => r.status !== 'delivered');
    console.log(failed.length === 0
      ? '\n✓ Every destination accepted the message. Go look at your channels.\n'
      : `\n${failed.length} destination(s) did not accept it — see the reason above each.\n  (The worker retries automatically; this script only tried once.)\n`);
  } finally {
    await sql.end();
  }
}

await main();
