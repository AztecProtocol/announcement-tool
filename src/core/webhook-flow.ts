import type { Sql } from 'postgres';
import { createSubscription, verifySubscription, type SubscriptionFilters } from './subscriptions.js';
import { assertDeliverableUrl, signPayload } from '../adapters/webhook.js';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export async function registerWebhook(
  sql: Sql,
  input: {
    url: string; filters?: Partial<SubscriptionFilters>;
    fetchImpl?: typeof fetch; allowPrivateHosts?: boolean; timeoutMs?: number;
  },
): Promise<{ secretOnce?: string; verified: boolean; error?: string }> {
  try {
    assertDeliverableUrl(input.url, input.allowPrivateHosts);
  } catch (err) {
    return { verified: false, error: String(err instanceof Error ? err.message : err) };
  }

  const existing = await sql`select id, secret from subscriptions
    where channel = 'webhook' and endpoint = ${input.url}`;
  let subId: string, secret: string, secretOnce: string | undefined;
  if (existing[0]) {
    subId = existing[0].id as string;
    secret = existing[0].secret as string;
    const filterErr = await applyFilters(sql, subId, input.filters);
    if (filterErr) return filterErr;
  } else {
    try {
      const sub = await createSubscription(sql, { channel: 'webhook', endpoint: input.url, filters: input.filters });
      subId = sub.id; secret = sub.secret!; secretOnce = sub.secret;
    } catch (err) {
      // Concurrent registration for the same (channel, endpoint) lost the race to
      // another request between our select and our insert. Fall through to the
      // already-exists handling rather than letting the unique-violation propagate
      // — registerWebhook must never throw for "already exists".
      if (!isUniqueViolation(err)) throw err;
      const row = await sql`select id, secret from subscriptions
        where channel = 'webhook' and endpoint = ${input.url}`;
      if (!row[0]) throw err; // row vanished again; surface the original error
      subId = row[0].id as string;
      secret = row[0].secret as string;
      const filterErr = await applyFilters(sql, subId, input.filters);
      if (filterErr) return filterErr;
    }
  }

  const doFetch = input.fetchImpl ?? fetch;
  const body = JSON.stringify({
    event_id: `whtest_${subId}`,
    kind: 'test',
    message: 'Aztec announcements webhook verification. Respond 2xx to activate this endpoint.',
  });
  const ts = String(Math.floor(Date.now() / 1000));
  try {
    const res = await doFetch(input.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-announce-event-id': `whtest_${subId}`,
        'x-announce-timestamp': ts,
        'x-announce-signature': `v1=${signPayload(secret, ts, body)}`,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { secretOnce, verified: false, error: `endpoint answered HTTP ${res.status}` };
  } catch (err) {
    return { secretOnce, verified: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
  await verifySubscription(sql, subId);
  return { secretOnce, verified: true };
}

async function applyFilters(
  sql: Sql, subId: string, f?: Partial<SubscriptionFilters>,
): Promise<{ secretOnce?: string; verified: boolean; error?: string } | undefined> {
  if (!f) return undefined;
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) && v.length === 0) return { verified: false, error: `filter ${k} must not be empty` };
  }
  if (f.networks) await sql`update subscriptions set filter_networks = ${f.networks} where id = ${subId}`;
  if (f.types) await sql`update subscriptions set filter_types = ${f.types} where id = ${subId}`;
  if (f.severities) await sql`update subscriptions set filter_severities = ${f.severities} where id = ${subId}`;
  if (f.audiences) await sql`update subscriptions set filter_audiences = ${f.audiences} where id = ${subId}`;
  return undefined;
}
