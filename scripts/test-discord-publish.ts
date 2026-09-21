/**
 * Check a real Discord bot and channel against the real publish code, from a
 * laptop, before the token goes into production. No database, no production
 * access — just a webhook post and the real `publishToFollowers`.
 *
 *   WEBHOOK_URL='https://discord.com/api/webhooks/…' \
 *   DISCORD_BOT_TOKEN='…' \
 *   npm run test:discord-publish
 *
 * `DISCORD_PUBLISH_TEST_STUB` and `DISCORD_API_BASE_OVERRIDE` exist only for
 * this script's own automated test: they let a `127.0.0.1` stub stand in for
 * discord.com. They are useless against a real host, because
 * `publishToFollowers` itself refuses any `apiBase` that is not https and not
 * loopback — setting them does not weaken that check.
 */
import { pathToFileURL } from 'node:url';
import { publishToFollowers, DISCORD_API_BASE } from '../src/adapters/discord-publish.js';

const SNOWFLAKE = /^\d{5,25}$/;

function redact(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

// Accepts discord.com and discordapp.com, plus their client-build subdomains
// (ptb., canary.) that real users copy webhook URLs from. `endsWith` alone
// would also accept a suffix match like "evildiscord.com" ending in
// "discord.com" with no dot — the leading `.` in the suffix check is what
// keeps that refused. HTTPS is required for every accepted host; the
// loopback stub is a separate, narrower exception used only by this script's
// own test.
export function isDiscordWebhookHost(url: URL, allowStub: boolean): boolean {
  if (allowStub && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    return true;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'discord.com' || url.hostname.endsWith('.discord.com')
    || url.hostname === 'discordapp.com' || url.hostname.endsWith('.discordapp.com');
}

async function main(): Promise<number> {
  const webhookUrl = process.env.WEBHOOK_URL;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!webhookUrl || !botToken) {
    console.error('Usage: WEBHOOK_URL=... DISCORD_BOT_TOKEN=... npm run test:discord-publish');
    console.error('Both WEBHOOK_URL and DISCORD_BOT_TOKEN are required.');
    return 2;
  }

  const isTestStub = process.env.DISCORD_PUBLISH_TEST_STUB === '1';
  let parsedWebhook: URL;
  try {
    parsedWebhook = new URL(webhookUrl);
  } catch {
    console.error('WEBHOOK_URL must be a discord.com webhook');
    return 2;
  }
  if (!isDiscordWebhookHost(parsedWebhook, isTestStub)) {
    console.error('WEBHOOK_URL must be a discord.com webhook');
    return 2;
  }

  const apiBaseOverride = isTestStub ? process.env.DISCORD_API_BASE_OVERRIDE : undefined;
  const apiBase = apiBaseOverride ?? DISCORD_API_BASE;

  parsedWebhook.searchParams.set('wait', 'true');

  const timestamp = new Date().toISOString();
  const payload = {
    content: `Publish check ${timestamp} — a test of the announcement tool, please ignore.`,
    allowed_mentions: { parse: [] },
  };

  let postRes: Response;
  try {
    postRes = await fetch(parsedWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const raw = String(err instanceof Error ? err.message : err);
    console.error(`post failed: ${redact(raw, botToken)}`);
    return 1;
  }

  if (!postRes.ok) {
    console.error(`post failed: HTTP ${postRes.status}`);
    return 1;
  }

  const posted = await postRes.json().catch(() => null) as { id?: unknown; channel_id?: unknown } | null;
  const messageId = posted?.id;
  const channelId = posted?.channel_id;
  console.log(`posted: message ${String(messageId)} in channel ${String(channelId)}`);

  const note = await publishToFollowers({
    botToken,
    channelId,
    messageId,
    ...(apiBaseOverride ? { apiBase: apiBaseOverride } : {}),
  });
  console.log(`publish: ${note}`);

  if (note === 'published'
    && typeof channelId === 'string' && SNOWFLAKE.test(channelId)
    && typeof messageId === 'string' && SNOWFLAKE.test(messageId)) {
    const base = apiBase.replace(/\/+$/, '');

    // The token must never depend on a check made forty lines away (the
    // apiBase validation inside publishToFollowers). Re-check here, right
    // before the Authorization header is built, so this fetch is safe even
    // if that earlier guard is ever changed or bypassed.
    let baseIsSecure = false;
    try {
      const parsedBase = new URL(base);
      baseIsSecure = parsedBase.protocol === 'https:'
        || parsedBase.hostname === '127.0.0.1' || parsedBase.hostname === 'localhost' || parsedBase.hostname === '[::1]';
    } catch {
      baseIsSecure = false;
    }
    if (!baseIsSecure) {
      console.log('second publish: skipped (insecure api base)');
      return note === 'published' ? 0 : 1;
    }

    try {
      const res = await fetch(`${base}/channels/${channelId}/messages/${messageId}/crosspost`, {
        method: 'POST',
        headers: { authorization: `Bot ${botToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      const body = await res.json().catch(() => null) as { code?: unknown; message?: unknown } | null;
      console.log(`second publish of the same message: HTTP ${res.status}`);
      if (body && typeof body === 'object') {
        if ('code' in body) console.log(`  code: ${String(body.code)}`);
        if ('message' in body) console.log(`  message: ${String(body.message)}`);
      }
    } catch (err) {
      const raw = String(err instanceof Error ? err.message : err);
      console.log(`second publish: ${redact(raw, botToken)}`);
    }
  }

  return note === 'published' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main().catch(err => {
    const raw = String(err instanceof Error ? err.message : err);
    console.error(`unexpected error: ${redact(raw, process.env.DISCORD_BOT_TOKEN ?? '')}`);
    return 1;
  });
  process.exit(exitCode);
}
