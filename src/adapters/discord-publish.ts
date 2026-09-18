/**
 * Publishing ("crossposting") a message in a Discord Announcement channel, so
 * that servers following the channel receive it.
 *
 * A webhook cannot do this: Execute Webhook has no such parameter. It is a
 * separate, bot-authenticated call. And because a webhook's message is not
 * authored by the bot, the bot needs MANAGE_MESSAGES as well as SEND_MESSAGES
 * in the channel. (Discord API docs, checked 2026-09-17.)
 *
 * This runs AFTER the announcement has been delivered. Nothing here may throw:
 * a throw would make the worker retry the delivery and post a second copy. The
 * outcome is a short note for the delivery ledger.
 */
export const DISCORD_API_BASE = 'https://discord.com/api/v10';

const GUILD_ANNOUNCEMENT = 5;
// Ids from the webhook's response go into a URL path. They are Discord
// snowflakes (digits); anything else is refused rather than interpolated.
const SNOWFLAKE = /^\d{5,25}$/;
const MAX_RATE_LIMIT_WAIT_SECONDS = 10;

export async function publishToFollowers(input: {
  botToken: string; channelId: unknown; messageId: unknown;
  apiBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  try {
    const { channelId, messageId } = input;
    if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)
      || typeof messageId !== 'string' || !SNOWFLAKE.test(messageId)) {
      return 'failed: no message id';
    }
    const base = (input.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, '');
    const doFetch = input.fetchImpl ?? fetch;
    const timeoutMs = input.timeoutMs ?? 10_000;
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const headers = {
      authorization: `Bot ${input.botToken}`,
      'user-agent': 'DiscordBot (https://announce.aztec.network, 1.0)',
    };

    // Only an Announcement channel can be published; on a text channel the
    // call fails. Look the type up rather than assume it.
    const ch = await doFetch(`${base}/channels/${channelId}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!ch.ok) return `failed: channel lookup HTTP ${ch.status}`;
    const channel = await ch.json() as { type?: unknown };
    if (channel.type !== GUILD_ANNOUNCEMENT) return 'skipped: not an announcement channel';

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await doFetch(`${base}/channels/${channelId}/messages/${messageId}/crosspost`, {
        method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return 'published';
      if (res.status === 429) {
        const body = await res.json().catch(() => ({})) as { retry_after?: unknown };
        const wait = Number(body.retry_after);
        if (attempt === 0 && Number.isFinite(wait) && wait >= 0 && wait <= MAX_RATE_LIMIT_WAIT_SECONDS) {
          await sleep(Math.ceil(wait * 1000));
          continue;
        }
        return `failed: rate limited (retry after ${Number.isFinite(wait) ? Math.ceil(wait) : '?'}s)`;
      }
      return `failed: crosspost HTTP ${res.status}`;
    }
    return 'failed: rate limited (retry after ?s)';
  } catch (err) {
    // A fetch error message names the host, never a header, so the token
    // cannot appear here; the slice bounds what reaches the ledger.
    return `failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`;
  }
}
