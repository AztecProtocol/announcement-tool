import type { Sql } from 'postgres';
import type { ChannelAdapter } from './types.js';
import type { Announcement, DeliveryKind } from '../core/types.js';
import { renderMarkdown } from '../core/render.js';

async function loadSetting(sql: Sql, target: string): Promise<Record<string, unknown>> {
  const rows = await sql`select config from channel_settings where key = ${target}`;
  if (!rows[0]) throw new Error(`channel setting not found: ${target}`);
  return rows[0].config as Record<string, unknown>;
}

export function makeDiscordAdapter(
  sql: Sql, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): ChannelAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    channel: 'discord',
    async deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void> {
      const cfg = await loadSetting(sql, target);
      const webhookUrl = cfg.webhook_url as string | undefined;
      if (!webhookUrl) throw new Error(`discord setting ${target} has no webhook_url`);

      const prefix = (cfg.prefix as string | undefined)?.trim();
      const content = prefix ? `${prefix}\n${renderMarkdown(a, kind)}` : renderMarkdown(a, kind);

      const res = await doFetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content,
          ...(cfg.username ? { username: cfg.username as string } : {}),
          allowed_mentions: { parse: ['roles', 'everyone'] },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`discord delivery failed: HTTP ${res.status}`);
    },
  };
}
