/**
 * Interactive helper: add or update one broadcast channel destination.
 *
 *   npm run setup:channel
 *
 * Asks a few questions, writes one row to channel_settings, prints it back.
 * Safe to re-run: re-answering for the same key overwrites that row.
 */
import postgres from 'postgres';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const DB = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const rl = createInterface({ input: stdin, output: stdout });

const ask = async (q: string, fallback = ''): Promise<string> => {
  const answer = (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim();
  return answer || fallback;
};

const askList = async (q: string, allowed: string[], fallback: string): Promise<string[]> => {
  for (;;) {
    const raw = await ask(`${q} (comma-separated from: ${allowed.join(', ')})`, fallback);
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    const bad = parts.filter(p => !allowed.includes(p));
    if (parts.length && bad.length === 0) return parts;
    console.log(`  ✗ not valid: ${bad.join(', ') || '(empty)'} — try again`);
  }
};

async function main(): Promise<void> {
  console.log('\nAdd a channel destination\n=========================\n');

  const channel = await ask('Which channel? (discord / telegram / signal)', 'discord');
  if (!['discord', 'telegram', 'signal'].includes(channel)) {
    console.error(`\n✗ "${channel}" is not one of discord, telegram, signal.`);
    process.exitCode = 1;
    return;
  }

  const defaultKey = channel === 'discord' ? 'discord:test-updates' : `${channel}:test`;
  const key = await ask('Name for this destination (its unique id)', defaultKey);

  const networks = await askList('Which networks should post here?', ['mainnet', 'testnet'], 'mainnet,testnet');
  const types = await askList('Which announcement types?', ['upgrade', 'governance', 'info'], 'upgrade,governance,info');

  const config: Record<string, unknown> = { networks, types };

  if (channel === 'discord') {
    config.webhook_url = await ask('Discord webhook URL (Channel Settings -> Integrations -> Webhooks)');
    const prefix = await ask('Text to put above every message — role mentions/emoji (blank for none)', '');
    if (prefix) config.prefix = prefix;
    const username = await ask('Bot display name in Discord', 'Aztec Announcements');
    if (username) config.username = username;
  } else if (channel === 'telegram') {
    config.chat_id = await ask('Telegram channel id (e.g. @MyTestChannel, or a -100... number)');
  } else {
    config.group_id = await ask('Signal group id (from: signal-cli listGroups)');
  }

  const sql = postgres(DB, { max: 1 });
  try {
    await sql`insert into channel_settings (key, channel, config)
      values (${key}, ${channel}, ${sql.json(config)})
      on conflict (key) do update set channel = excluded.channel, config = excluded.config`;
    const [row] = await sql`select key, channel, config from channel_settings where key = ${key}`;
    console.log('\n✓ Saved this destination:\n');
    console.log(JSON.stringify(row, null, 2));
    console.log('\nRun it again any time to change these answers.\n');
  } finally {
    await sql.end();
    rl.close();
  }
}

await main();
