import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ChannelAdapter } from './types.js';
import type { Announcement, DeliveryKind } from '../core/types.js';
import { getSubscription } from '../core/subscriptions.js';
import { isForbiddenHostname, resolveDeliverableUrl, pinnedDispatcher, URL_NOT_ALLOWED, type LookupFn } from '../core/safe-url.js';

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Synchronous pre-check kept for callers that only have a string; the full
 * decision (resolution + pinning) is resolveDeliverableUrl. */
export function assertDeliverableUrl(url: string, allowPrivateHosts = false): void {
  if (allowPrivateHosts) return;
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(URL_NOT_ALLOWED); }
  if (u.protocol !== 'https:' || isForbiddenHostname(u.hostname)) throw new Error(URL_NOT_ALLOWED);
}

export function makeWebhookAdapter(
  sql: Sql,
  opts: { fetchImpl?: typeof fetch; allowPrivateHosts?: boolean; timeoutMs?: number; lookup?: LookupFn } = {},
): ChannelAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    channel: 'webhook',
    async deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void> {
      const sub = await getSubscription(sql, target);
      if (!sub || !sub.secret) throw new Error(`webhook subscription not found: ${target}`);
      const { addresses } = await resolveDeliverableUrl(sub.endpoint, { lookup: opts.lookup, allowPrivateHosts: opts.allowPrivateHosts });
      const dispatcher = addresses.length ? pinnedDispatcher(addresses) : undefined;

      const body = JSON.stringify({
        event_id: `${a.id}.${a.revision}.${kind}`,
        kind,
        announcement: {
          id: a.id, revision: a.revision, slug: a.slug, type: a.type,
          networks: a.networks, audiences: a.audiences, severity: a.severity,
          title: a.title, body_md: a.bodyMd, actions_required: a.actionsRequired,
          links: a.links, published_at: a.publishedAt ?? null,
        },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      try {
        const res = await doFetch(sub.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-announce-event-id': `${a.id}.${a.revision}.${kind}`,
            'x-announce-timestamp': ts,
            'x-announce-signature': `v1=${signPayload(sub.secret, ts, body)}`,
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          // Node's fetch honours `dispatcher` at runtime; the DOM RequestInit
          // type it is declared with does not carry the field.
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit & { dispatcher?: unknown });
        if (!res.ok) throw new Error(`webhook delivery failed: HTTP ${res.status}`);
      } finally {
        await dispatcher?.close();
      }
    },
  };
}
