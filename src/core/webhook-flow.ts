import type { Sql } from 'postgres';
import { createSubscription, updateSubscriptionFilters, verifySubscription, type Subscription, type SubscriptionFilters } from './subscriptions.js';
import { assertDeliverableUrl, signPayload } from '../adapters/webhook.js';
import { publicBaseUrl } from './public-base-url.js';

const NOT_AUTHORIZED = 'not authorized or not registered';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function base(baseUrl?: string): string {
  return publicBaseUrl(baseUrl);
}

function emptyFilterError(f?: Partial<SubscriptionFilters>): string | undefined {
  if (!f) return undefined;
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) && v.length === 0) return `filter ${k} must not be empty`;
  }
  return undefined;
}

export async function registerWebhook(
  sql: Sql,
  input: {
    url: string; filters?: Partial<SubscriptionFilters>; secret?: string;
    fetchImpl?: typeof fetch; allowPrivateHosts?: boolean; timeoutMs?: number; baseUrl?: string;
    // Injectable in place of the real createSubscription — used by tests to
    // simulate the concurrent-insert race (create the row, then throw 23505)
    // without fighting ESM module mocking.
    createSubscriptionImpl?: typeof createSubscription;
  },
): Promise<{ secretOnce?: string; unsubscribeUrl?: string; verified: boolean; error?: string }> {
  try {
    assertDeliverableUrl(input.url, input.allowPrivateHosts);
  } catch (err) {
    return { verified: false, error: String(err instanceof Error ? err.message : err) };
  }

  const topLevelFilterErr = emptyFilterError(input.filters);
  if (topLevelFilterErr) return { verified: false, error: topLevelFilterErr };

  const doCreate = input.createSubscriptionImpl ?? createSubscription;

  const existing = await sql`select id, secret from subscriptions
    where channel = 'webhook' and endpoint = ${input.url}`;
  let subId: string, secret: string, secretOnce: string | undefined, unsubscribeUrl: string | undefined;
  if (existing[0]) {
    // Modifying an existing registration requires the secret it was issued
    // with; a wrong or absent secret gets the exact same generic error as
    // the no-such-URL case below, so the response can't be used to probe
    // registered URLs.
    if (input.secret === undefined || input.secret !== existing[0].secret) {
      return { verified: false, error: NOT_AUTHORIZED };
    }
    subId = existing[0].id as string;
    secret = existing[0].secret as string;
    const filterErr = await applyFilters(sql, subId, input.filters);
    if (filterErr) return filterErr;
  } else if (input.secret !== undefined) {
    // Unknown URL, but a secret was supplied — this only happens on an attempt
    // to modify an existing registration, so answer identically to the
    // wrong-secret case above rather than falling through to first-time
    // registration (which would create a row and reveal the URL was unknown).
    return { verified: false, error: NOT_AUTHORIZED };
  } else {
    try {
      const sub: Subscription = await doCreate(sql, { channel: 'webhook', endpoint: input.url, filters: input.filters });
      subId = sub.id; secret = sub.secret!; secretOnce = sub.secret;
      unsubscribeUrl = `${base(input.baseUrl)}/u/${sub.unsubscribeToken}`;
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
    if (!res.ok) return { secretOnce, unsubscribeUrl, verified: false, error: `endpoint answered HTTP ${res.status}` };
  } catch (err) {
    return { secretOnce, unsubscribeUrl, verified: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
  await verifySubscription(sql, subId);
  return { secretOnce, unsubscribeUrl, verified: true };
}

async function applyFilters(
  sql: Sql, subId: string, f?: Partial<SubscriptionFilters>,
): Promise<{ secretOnce?: string; unsubscribeUrl?: string; verified: boolean; error?: string } | undefined> {
  if (!f) return undefined;
  try {
    await updateSubscriptionFilters(sql, subId, f);
  } catch (err) {
    // registerWebhook's contract: never throw, always return { verified: false, error }.
    return { verified: false, error: err instanceof Error ? err.message : String(err) };
  }
  return undefined;
}
