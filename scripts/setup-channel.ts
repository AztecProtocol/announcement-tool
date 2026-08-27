/**
 * Interactive helper: add or update one broadcast channel destination.
 *
 *   npm run setup:channel
 *
 * Asks a few questions, writes one row to channel_settings, prints it back.
 *
 * Re-running for an EXISTING key prefills every answer from the stored row, so
 * pressing Enter through the prompts keeps the current value. This matters: the
 * write below replaces the whole config object, so before prefilling existed a
 * re-run that skipped the webhook-URL prompt silently saved an empty URL and
 * broke every delivery to that destination.
 */
import postgres from 'postgres';
import { loadEnv } from '../src/env.js';
loadEnv();
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { validatePrefix } from '../src/core/discord-mentions.js';
import { enabledChannels, isChannelEnabled } from '../src/core/enabled-channels.js';
import type { ChannelName } from '../src/worker/adapters.js';

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
  console.log('\nAdd or update a channel destination\n==================================\n');

  // Opened before the prompts so an existing row can prefill them.
  const sql = postgres(DB, { max: 1 });
  try {

  const channel = await ask('Which channel? (discord / telegram / signal)', 'discord');
  if (!['discord', 'telegram', 'signal'].includes(channel)) {
    console.error(`\n✗ "${channel}" is not one of discord, telegram, signal.`);
    process.exitCode = 1;
    return; // the finally below still closes the pool and the readline interface
  }

  if (!isChannelEnabled(channel as ChannelName)) {
    console.error(
      `Channel "${channel}" is not enabled in this deployment.\n`
      + `ENABLED_CHANNELS currently allows: ${enabledChannels().join(', ')}.\n`
      + 'A destination configured on a disabled channel would never receive an announcement, '
      + 'and would not appear in the admin UI. Enable the channel first, then re-run this.',
    );
    process.exitCode = 1;
    return; // the finally below still closes the pool and the readline interface
  }

  const defaultKey = channel === 'discord' ? 'discord:test-updates' : `${channel}:test`;
  const key = await ask('Name for this destination (its unique id)', defaultKey);

  const [existingRow] = await sql`select config from channel_settings where key = ${key}`;
  const existing = (existingRow?.config ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof existing[k] === 'string' ? existing[k] as string : '');
  const list = (k: string, fallback: string): string =>
    Array.isArray(existing[k]) ? (existing[k] as string[]).join(',') : fallback;

  if (existingRow) {
    console.log(`\n  Updating the existing "${key}". Press Enter at any prompt to keep the current value.\n`);
  }

  const networks = await askList('Which networks should post here?', ['mainnet', 'testnet'], list('networks', 'mainnet,testnet'));
  const types = await askList('Which announcement types?', ['upgrade', 'governance', 'info'], list('types', 'upgrade,governance,info'));

  const config: Record<string, unknown> = { networks, types };

  if (channel === 'discord') {
    for (;;) {
      config.webhook_url = await ask('Discord webhook URL (Channel Settings -> Integrations -> Webhooks)', str('webhook_url'));
      if (config.webhook_url) break;
      console.log('  ✗ a webhook URL is required — without one nothing can be posted');
    }

    // Roles are a list, so "press Enter to keep" cannot work per-prompt as it
    // does for single values. Instead: show what is stored and ask once whether
    // to replace the whole list. Answering no leaves it exactly as it was.
    const existingRoles = Array.isArray(existing.roles)
      ? existing.roles as { name: string; id: string }[]
      : [];
    let keepRoles = false;
    if (existingRoles.length) {
      console.log(`\n  Roles currently mentioned: ${existingRoles.map(r => `${r.name} (${r.id})`).join(', ')}`);
      const replace = await ask('  Replace this role list? (y/N)', 'n');
      keepRoles = !/^y/i.test(replace);
    }

    if (keepRoles) {
      config.roles = existingRoles;
    } else {
      const roles: { name: string; id: string }[] = [];
      for (;;) {
        const name = await ask('Add a role to mention? Enter a name, or blank to finish');
        if (!name) break;
        let id = '';
        for (;;) {
          id = await ask('  Role ID (Discord: enable Developer Mode, right-click the role, Copy Role ID)');
          if (/^\d+$/.test(id)) break;
          console.log('  ✗ role id must be all digits — try again');
        }
        roles.push({ name, id });
      }
      // Dedupe by id so a re-entered role cannot produce two mention tokens
      // for the same id, e.g. <@&111> <@&111>, if the operator adds it twice.
      const dedupedRoles = roles.filter((r, i) => roles.findIndex(x => x.id === r.id) === i);
      if (dedupedRoles.length) config.roles = dedupedRoles;
    }

    let prefix = '';
    for (;;) {
      prefix = await ask('Emoji preamble to put above every message (blank for none)', str('prefix'));
      const err = validatePrefix(prefix);
      if (!err) break;
      console.log(`  ✗ ${err} — try again`);
    }
    if (prefix) config.prefix = prefix;
    const username = await ask('Bot display name in Discord', str('username') || 'Aztec Announcements');
    if (username) config.username = username;
  } else if (channel === 'telegram') {
    for (;;) {
      config.chat_id = await ask('Telegram channel id (e.g. @MyTestChannel, or a -100... number)', str('chat_id'));
      if (config.chat_id) break;
      console.log('  ✗ a chat id is required');
    }
  } else {
    for (;;) {
      config.group_id = await ask('Signal group id (from: signal-cli listGroups)', str('group_id'));
      if (config.group_id) break;
      console.log('  ✗ a group id is required');
    }
  }

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
