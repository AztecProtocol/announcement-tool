import postgres from 'postgres';
import { runFanoutOnce } from './fanout.js';
import { dispatchHealthAlerts } from '../core/alerts.js';
import type { ChannelAdapter } from '../adapters/types.js';
import { makeWebhookAdapter } from '../adapters/webhook.js';
import { makeDiscordAdapter } from '../adapters/discord.js';
import { makeTelegramAdapter } from '../adapters/telegram.js';
import { makeEmailAdapter } from '../adapters/email.js';
import { makeSignalAdapter } from '../adapters/signal.js';
import { senderFromEnv } from '../adapters/esp.js';

const url = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const sql = postgres(url, { max: 4 });
const sender = senderFromEnv();

const adapters: Record<string, ChannelAdapter> = {
  webhook: makeWebhookAdapter(sql),
  discord: makeDiscordAdapter(sql),
  telegram: makeTelegramAdapter(sql),
  email: makeEmailAdapter(sql, sender),
  signal: makeSignalAdapter(sql),
};

console.log(`fan-out worker started (15s interval, esp=${sender.name}, channels=${Object.keys(adapters).join(',')})`);
setInterval(async () => {
  try {
    const { delivered, failed } = await runFanoutOnce(sql, adapters);
    if (delivered || failed) console.log(`fanout: delivered=${delivered} failed=${failed}`);
    const alerted = await dispatchHealthAlerts(sql, sender);
    for (const i of alerted) console.warn(`HEALTH ${i.kind} [${i.channel}] ${i.announcementId}: ${i.detail}`);
  } catch (err) {
    console.error('fanout tick error:', err);
  }
}, 15_000);
