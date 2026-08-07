import postgres from 'postgres';
import { runFanoutOnce } from './fanout.js';
import type { ChannelAdapter } from '../adapters/types.js';
import { makeWebhookAdapter } from '../adapters/webhook.js';

const url = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const sql = postgres(url, { max: 4 });
const adapters: Record<string, ChannelAdapter> = { webhook: makeWebhookAdapter(sql) };

console.log('fan-out worker started (15s interval)');
setInterval(async () => {
  try {
    const { delivered, failed } = await runFanoutOnce(sql, adapters);
    if (delivered || failed) console.log(`fanout: delivered=${delivered} failed=${failed}`);
  } catch (err) {
    console.error('fanout tick error:', err);
  }
}, 15_000);
