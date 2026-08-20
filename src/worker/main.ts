import postgres from 'postgres';
import { loadEnv } from '../env.js';
loadEnv();
import { checkEnvironment } from '../core/production-guard.js';
import { assertPublishersConfigured } from '../core/identity.js';
import { runFanoutOnce } from './fanout.js';
import { dispatchHealthAlerts } from '../core/alerts.js';
import { publishDueScheduled } from '../core/announcements.js';
import type { ChannelAdapter } from '../adapters/types.js';
import { makeWebhookAdapter } from '../adapters/webhook.js';
import { makeDiscordAdapter } from '../adapters/discord.js';
import { makeTelegramAdapter } from '../adapters/telegram.js';
import { makeEmailAdapter } from '../adapters/email.js';
import { makeSignalAdapter } from '../adapters/signal.js';
import { senderFromEnv } from '../adapters/esp.js';

// The worker does not bind a port, so HOSTNAME is not strictly its own
// concern — but it shares the environment with the web app, and a wrong
// HOSTNAME there means the web app is exposed. Failing both processes on
// the same environment is deliberate: one check, one story, easier to reason
// about than two different rules for two processes.
const problems = checkEnvironment({
  adminEmail: process.env.ADMIN_EMAIL,
  hostname: process.env.HOSTNAME,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
});
if (problems.length > 0) {
  console.error('Refusing to start: unsafe production configuration.');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const sql = postgres(url, { max: 4 });

try {
  await assertPublishersConfigured(sql, {
    adminEmail: process.env.ADMIN_EMAIL,
    hostname: process.env.HOSTNAME,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const sender = senderFromEnv();

const adapters: Record<string, ChannelAdapter> = {
  webhook: makeWebhookAdapter(sql),
  discord: makeDiscordAdapter(sql),
  telegram: makeTelegramAdapter(sql),
  email: makeEmailAdapter(sql, sender),
  signal: makeSignalAdapter(sql),
};

console.log(`fan-out worker started (15s interval, scheduling on, esp=${sender.name}, channels=${Object.keys(adapters).join(',')})`);
setInterval(async () => {
  // Scheduling gets its own try/catch: a failing scheduler must not skip
  // fan-out or health alerting on this tick — those are the mechanisms that
  // would tell an operator something is wrong, so they must keep running
  // even while the scheduler is broken.
  try {
    const due = await publishDueScheduled(sql);
    for (const a of due) console.log(`scheduled publish sent: ${a.id} (${a.slug})`);
  } catch (err) {
    console.error('scheduled publish error:', err);
  }
  try {
    const { delivered, failed } = await runFanoutOnce(sql, adapters);
    if (delivered || failed) console.log(`fanout: delivered=${delivered} failed=${failed}`);
    const alerted = await dispatchHealthAlerts(sql, sender);
    for (const i of alerted) console.warn(`HEALTH ${i.kind} [${i.channel}] ${i.announcementId}: ${i.detail}`);
  } catch (err) {
    console.error('fanout tick error:', err);
  }
}, 15_000);
