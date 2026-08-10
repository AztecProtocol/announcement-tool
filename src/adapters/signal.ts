import type { Sql } from 'postgres';
import type { ChannelAdapter } from './types.js';
import type { Announcement, DeliveryKind } from '../core/types.js';
import { renderPlain } from '../core/render.js';

/**
 * Signal has no official bot API. This talks to a signal-cli-rest-api sidecar
 * (bbernhard/signal-cli-rest-api) holding a registered number. It is the least
 * reliable channel by design — errors carry the API body so channel-health
 * alerting surfaces registration/protocol breakage instead of silent loss.
 */
export function makeSignalAdapter(
  sql: Sql,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; apiBase?: string; account?: string } = {},
): ChannelAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return {
    channel: 'signal',
    async deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void> {
      const account = opts.account ?? process.env.SIGNAL_ACCOUNT;
      if (!account) throw new Error('SIGNAL_ACCOUNT is not set');
      const apiBase = (opts.apiBase ?? process.env.SIGNAL_API_BASE ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

      const rows = await sql`select config from channel_settings where key = ${target}`;
      if (!rows[0]) throw new Error(`channel setting not found: ${target}`);
      const cfg = rows[0].config as Record<string, unknown>;
      const groupId = cfg.group_id as string | undefined;
      if (!groupId) throw new Error(`signal setting ${target} has no group_id`);

      const res = await doFetch(`${apiBase}/v2/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: renderPlain(a, kind), number: account, recipients: [groupId] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`signal delivery failed: HTTP ${res.status} ${detail}`.trim());
      }
    },
  };
}
