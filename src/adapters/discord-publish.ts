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
 *
 * Token secrecy is structural, not incidental: the token appears only in the
 * `Authorization` header we build ourselves. Every other string that reaches
 * the ledger — an upstream response body, a caught error's message — is
 * either discarded outright or redacted before it is used, so secrecy does
 * not depend on undici's (or any fetch library's) error-formatting habits.
 *
 * Note strings this module can return, beyond the ones already documented
 * inline: `failed: channel lookup returned no JSON`, `failed: insecure api
 * base`.
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

    // The token is sent to whatever apiBase is given. Refuse anything that
    // is not HTTPS or a local loopback (tests point apiBase at 127.0.0.1),
    // before any request is made — a plaintext or otherwise untrusted host
    // must never see the Authorization header.
    let parsedBase: URL;
    try { parsedBase = new URL(base); } catch { return 'failed: insecure api base'; }
    const isLocal = parsedBase.hostname === '127.0.0.1' || parsedBase.hostname === 'localhost' || parsedBase.hostname === '[::1]' || parsedBase.hostname === '::1';
    if (parsedBase.protocol !== 'https:' && !isLocal) return 'failed: insecure api base';

    const doFetch = input.fetchImpl ?? fetch;
    const timeoutMs = input.timeoutMs ?? 10_000;
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const headers = {
      authorization: `Bot ${input.botToken}`,
      'user-agent': 'DiscordBot (https://announce.aztec.network, 1.0)',
    };

    // Only an Announcement channel can be published; on a text channel the
    // call fails. Look the type up rather than assume it.
    // redirect: 'error' — a redirect from either of these two endpoints is
    // never legitimate, and following one could send the token elsewhere.
    const ch = await doFetch(`${base}/channels/${channelId}`, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!ch.ok) return `failed: channel lookup HTTP ${ch.status}`;
    const channel = await ch.json().catch(() => null) as { type?: unknown } | null;
    if (!channel || typeof channel !== 'object') return 'failed: channel lookup returned no JSON';
    if (channel.type !== GUILD_ANNOUNCEMENT) return 'skipped: not an announcement channel';

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await doFetch(`${base}/channels/${channelId}/messages/${messageId}/crosspost`, {
        method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
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
    // Secrecy here is by construction, not by the fetch library's habits: a
    // foreign error message could in principle carry the token (e.g. a proxy
    // echoing the request line back), so redact it before bounding the
    // length, rather than trusting undici's error formatting to omit it.
    const raw = String(err instanceof Error ? err.message : err);
    const safe = input.botToken ? raw.split(input.botToken).join('***') : raw;
    return `failed: ${safe.slice(0, 120)}`;
  }
}
