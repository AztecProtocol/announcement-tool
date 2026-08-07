import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ChannelAdapter } from './types.js';
import type { Announcement, DeliveryKind } from '../core/types.js';
import { getSubscription } from '../core/subscriptions.js';

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

const PRIVATE_HOST = [
  /^localhost$/i, /\.local$/i,
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/, /^\[::1\]$/,
];

export function assertDeliverableUrl(url: string, allowPrivateHosts = false): void {
  const u = new URL(url);
  if (allowPrivateHosts) return;
  if (u.protocol !== 'https:') throw new Error(`webhook url must be https: ${url}`);
  if (PRIVATE_HOST.some(re => re.test(u.hostname))) throw new Error(`webhook url host not allowed: ${u.hostname}`);
}

export function makeWebhookAdapter(
  sql: Sql,
  opts: { fetchImpl?: typeof fetch; allowPrivateHosts?: boolean; timeoutMs?: number } = {},
): ChannelAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    channel: 'webhook',
    async deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void> {
      const sub = await getSubscription(sql, target);
      if (!sub || !sub.secret) throw new Error(`webhook subscription not found: ${target}`);
      assertDeliverableUrl(sub.endpoint, opts.allowPrivateHosts);

      const body = JSON.stringify({
        event_id: `${a.id}.${a.revision}.${kind}`,
        kind,
        announcement: {
          id: a.id, revision: a.revision, slug: a.slug, type: a.type,
          networks: a.networks, audiences: a.audiences, severity: a.severity,
          title: a.title, body_md: a.bodyMd, actions_required: a.actionsRequired,
          links: a.links, published_at: a.publishedAt ?? null, expires_at: a.expiresAt ?? null,
        },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await doFetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-announce-event-id': `${a.id}.${a.revision}.${kind}`,
          'x-announce-timestamp': ts,
          'x-announce-signature': `v1=${signPayload(sub.secret, ts, body)}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`webhook delivery failed: HTTP ${res.status}`);
    },
  };
}
