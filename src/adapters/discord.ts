import type { Sql } from 'postgres';
import type { ChannelAdapter, DeliveryResult } from './types.js';
import type { Announcement, DeliveryKind } from '../core/types.js';
import { renderMarkdown } from '../core/render.js';
import { composeMentionLine, mentionedRoleIds, mentionsEveryone } from '../core/discord-mentions.js';
import { publishToFollowers } from './discord-publish.js';

async function loadSetting(sql: Sql, target: string): Promise<Record<string, unknown>> {
  const rows = await sql`select config from channel_settings where key = ${target}`;
  if (!rows[0]) throw new Error(`channel setting not found: ${target}`);
  return rows[0].config as Record<string, unknown>;
}

// Env vars: DISCORD_BOT_TOKEN (optional) — when set, and a channel's
// auto_publish is not literally false, a delivered announcement is
// crossposted so servers following the channel receive it.
export function makeDiscordAdapter(
  sql: Sql,
  opts: {
    fetchImpl?: typeof fetch; timeoutMs?: number;
    // The publish calls run while the delivery row is locked (see fanout.ts).
    // They are two small metadata calls, so a short timeout bounds the lock
    // hold: worst case is roughly the webhook post (10s) plus the channel
    // lookup (5s) plus the crosspost (5s) plus one rate-limit wait (<=10s)
    // plus the retried crosspost (5s).
    botToken?: string; apiBase?: string; sleep?: (ms: number) => Promise<void>; publishTimeoutMs?: number;
  } = {},
): ChannelAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    channel: 'discord',
    async deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void | DeliveryResult> {
      const cfg = await loadSetting(sql, target);
      const webhookUrl = cfg.webhook_url as string | undefined;
      if (!webhookUrl) throw new Error(`discord setting ${target} has no webhook_url`);

      const prefix = composeMentionLine(cfg, a.mentionRoleIds);
      // Blank line between the mention prefix and the body, so the tag line is not
      // crowded against the role pings. The expression must stay byte-identical to
      // the one in src/core/preview.ts — that identity is what makes the Raw preview
      // a trustworthy record of what goes on the wire.
      const content = prefix ? `${prefix}\n\n${renderMarkdown(a, kind)}` : renderMarkdown(a, kind);

      // Publishing to following servers needs the created message's id, which
      // Discord returns only with ?wait=true. Ask for it only when a publish will
      // be attempted, so that without a bot token the request is byte-identical
      // to what this adapter has always sent.
      const botToken = opts.botToken ?? process.env.DISCORD_BOT_TOKEN;
      const autoPublish = cfg.auto_publish !== false;
      const willPublish = autoPublish && !!botToken;
      let postUrl = webhookUrl;
      if (willPublish) {
        const u = new URL(webhookUrl);
        u.searchParams.set('wait', 'true');
        postUrl = u.toString();
      }

      const res = await doFetch(postUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content,
          ...(cfg.username ? { username: cfg.username as string } : {}),
          // Permit exactly what was selected. `parse: []` plus an explicit role
          // list means a literal @everyone typed into a body cannot ping.
          // Caveat: Discord's everyone permission has no id-list form, so when
          // the author selects @everyone or @here, `parse: ['everyone']` also
          // re-enables a stray literal in the body. Unavoidable via this API,
          // and only when the author deliberately chose to notify everyone.
          allowed_mentions: {
            parse: mentionsEveryone(a.mentionRoleIds) ? ['everyone'] : [],
            roles: mentionedRoleIds(cfg, a.mentionRoleIds),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`discord delivery failed: HTTP ${res.status}`);

      // Delivered. From here on nothing may throw — see discord-publish.ts.
      if (!autoPublish) return { publishNote: 'skipped: auto_publish is off' };
      if (!botToken) return { publishNote: 'skipped: no bot token' };
      let msg: { id?: unknown; channel_id?: unknown } = {};
      try { msg = await res.json() as typeof msg; } catch { /* 204 or not JSON: no id */ }
      return {
        publishNote: await publishToFollowers({
          botToken, channelId: msg?.channel_id, messageId: msg?.id,
          apiBase: opts.apiBase, fetchImpl: doFetch, timeoutMs: opts.publishTimeoutMs ?? 5_000, sleep: opts.sleep,
        }),
      };
    },
  };
}
