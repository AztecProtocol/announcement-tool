import type { Sql } from 'postgres';
import type { ChannelAdapter } from './types.js';
import type { Announcement, DeliveryKind } from '../core/types.js';
import { renderTelegramHtml } from '../core/render.js';

export function makeTelegramAdapter(
  sql: Sql,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; apiBase?: string; botToken?: string } = {},
): ChannelAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
  return {
    channel: 'telegram',
    async deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void> {
      const token = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

      const rows = await sql`select config from channel_settings where key = ${target}`;
      if (!rows[0]) throw new Error(`channel setting not found: ${target}`);
      const cfg = rows[0].config as Record<string, unknown>;
      const chatId = cfg.chat_id as string | undefined;
      if (!chatId) throw new Error(`telegram setting ${target} has no chat_id`);

      // HTML parse mode on purpose (not MarkdownV2, which needs ~18 characters
      // escaped and rejects the whole message on one miss): HTML needs only
      // &, <, > escaped, which the renderer does completely with balanced tags.
      const res = await doFetch(`${apiBase}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(a, kind),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`telegram delivery failed: HTTP ${res.status}`);
      const json = await res.json() as { ok?: boolean; description?: string };
      if (json.ok !== true) throw new Error(`telegram delivery failed: ${json.description ?? 'ok:false'}`);
    },
  };
}
