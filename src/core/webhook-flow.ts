import type { Sql } from 'postgres';
import { createSubscription, getSubscriptionByUnsubscribeToken, updateSubscriptionFilters, verifySubscription, type Subscription, type SubscriptionFilters } from './subscriptions.js';
import { signPayload } from '../adapters/webhook.js';
import { resolveDeliverableUrl, pinnedDispatcher, URL_NOT_ALLOWED, type LookupFn } from './safe-url.js';
import { publicBaseUrl } from './public-base-url.js';

const NOT_AUTHORIZED = 'not authorized or not registered';

/** The only failure text an anonymous caller ever sees for the verification
 * request. The upstream status, the exception, and the resolved address are
 * an oracle: they turn a blind server-side request into a port scan of
 * whatever the URL pointed at. Detail goes to the server log, keyed by the
 * subscription id, for the operator. */
export const ENDPOINT_NOT_VERIFIED =
  'The endpoint did not respond with a 2xx status. Check that your endpoint has the secret and is reachable from the internet, then click Send test event again.';

export interface RegisterResult { secretOnce?: string; manageUrl?: string; verified: boolean; error?: string }
export interface TestResult { verified: boolean; error?: string }

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

/**
 * Re-registration with the correct secret runs the test immediately, unlike
 * a fresh registration, because supplying the correct secret is proof the
 * caller already holds it — the precondition a fresh, no-secret call cannot
 * meet (and that the form path also lacks, which is why the form gets the
 * generic already-registered message instead of a live test send).
 */
export async function registerWebhook(
  sql: Sql,
  input: {
    url: string; filters?: Partial<SubscriptionFilters>; secret?: string;
    fetchImpl?: typeof fetch; allowPrivateHosts?: boolean; timeoutMs?: number; baseUrl?: string;
    lookup?: LookupFn;
    // Injectable in place of the real createSubscription — used by tests to
    // simulate the concurrent-insert race (create the row, then throw 23505)
    // without fighting ESM module mocking.
    createSubscriptionImpl?: typeof createSubscription;
  },
): Promise<RegisterResult> {
  // The destination is resolved and vetted BEFORE the row is created, so a
  // refused URL never reaches the database and never reaches the network.
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    ({ addresses } = await resolveDeliverableUrl(input.url, {
      lookup: input.lookup, allowPrivateHosts: input.allowPrivateHosts,
    }));
  } catch {
    return { verified: false, error: URL_NOT_ALLOWED };
  }

  const topLevelFilterErr = emptyFilterError(input.filters);
  if (topLevelFilterErr) return { verified: false, error: topLevelFilterErr };

  const doCreate = input.createSubscriptionImpl ?? createSubscription;

  const existing = await sql`select id, secret from subscriptions
    where channel = 'webhook' and endpoint = ${input.url}`;
  let subId: string, secret: string;
  let created = false;
  let secretOnce: string | undefined, manageUrl: string | undefined;
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
      manageUrl = `${base(input.baseUrl)}/manage/${sub.unsubscribeToken}`;
      created = true;
    } catch (err) {
      // Concurrent registration for the same (channel, endpoint) lost the race to
      // another request between our select and our insert. Fall through to the
      // already-exists handling rather than letting the unique-violation propagate
      // — registerWebhook must never throw for "already exists". Another request
      // won the race and created the row, so this call continues down the
      // existing-row path (it must not report itself as having created the row).
      if (!isUniqueViolation(err)) throw err;
      const row = await sql`select id, secret from subscriptions
        where channel = 'webhook' and endpoint = ${input.url}`;
      if (!row[0]) throw err; // row vanished again; surface the original error
      subId = row[0].id as string;
      secret = row[0].secret as string;
      const filterErr = await applyFilters(sql, subId, input.filters);
      if (filterErr) return filterErr;
      // The race loser did not create the row and was never given the
      // secret out of band (no secretOnce, no manageUrl) — it has no more
      // standing to trigger a signed test than a fresh, no-secret caller
      // does. Report unverified without sending; the winner's own return
      // (or an explicit Send test event click from whoever holds the
      // manage link) is what runs the verification.
      return { verified: false };
    }
  }

  if (created) {
    return { secretOnce, manageUrl, verified: false };
  }

  const r = await runVerification(sql, { id: subId, endpoint: input.url, secret }, addresses, input);
  return { ...r };
}

/**
 * Sends the signed test event to an already-resolved destination and marks
 * the row verified on 2xx. The only failure text a caller ever sees is
 * ENDPOINT_NOT_VERIFIED; detail goes to the server log keyed by subscription
 * id (P22).
 */
async function runVerification(
  sql: Sql,
  sub: { id: string; endpoint: string; secret: string },
  addresses: Array<{ address: string; family: 4 | 6 }>,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<TestResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    event_id: `whtest_${sub.id}`,
    kind: 'test',
    message: 'Aztec announcements webhook verification. Respond 2xx to activate this endpoint.',
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const dispatcher = addresses.length ? pinnedDispatcher(addresses) : undefined;
  try {
    const res = await doFetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-announce-event-id': `whtest_${sub.id}`,
        'x-announce-timestamp': ts,
        'x-announce-signature': `v1=${signPayload(sub.secret, ts, body)}`,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      // Node's fetch honours `dispatcher` at runtime; the DOM RequestInit
      // type it is declared with does not carry the field.
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: unknown });
    if (!res.ok) {
      console.warn(`webhook verification failed for subscription ${sub.id}: HTTP ${res.status}`);
      return { verified: false, error: ENDPOINT_NOT_VERIFIED };
    }
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err).slice(0, 200);
    console.warn(`webhook verification failed for subscription ${sub.id}: ${detail}`);
    return { verified: false, error: ENDPOINT_NOT_VERIFIED };
  } finally {
    await dispatcher?.close();
  }
  await verifySubscription(sql, sub.id);
  return { verified: true };
}

/**
 * Sends the test event for an existing webhook subscription, on demand.
 * Keyed by the unsubscribe token because that is what the registrant holds;
 * the secret is never asked for and never returned. The destination is
 * resolved again here (not trusted from registration time) so a DNS change
 * since then cannot point the pinned request at a private address.
 */
export async function sendWebhookTest(
  sql: Sql,
  input: { token: string; fetchImpl?: typeof fetch; allowPrivateHosts?: boolean; timeoutMs?: number; lookup?: LookupFn },
): Promise<TestResult> {
  const sub = await getSubscriptionByUnsubscribeToken(sql, input.token);
  if (!sub || sub.channel !== 'webhook' || !sub.secret) {
    return { verified: false, error: ENDPOINT_NOT_VERIFIED };
  }
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    ({ addresses } = await resolveDeliverableUrl(sub.endpoint, {
      lookup: input.lookup, allowPrivateHosts: input.allowPrivateHosts,
    }));
  } catch {
    console.warn(`webhook verification refused for subscription ${sub.id}: destination not allowed`);
    return { verified: false, error: ENDPOINT_NOT_VERIFIED };
  }
  return runVerification(sql, { id: sub.id, endpoint: sub.endpoint, secret: sub.secret }, addresses, input);
}

async function applyFilters(
  sql: Sql, subId: string, f?: Partial<SubscriptionFilters>,
): Promise<RegisterResult | undefined> {
  if (!f) return undefined;
  try {
    await updateSubscriptionFilters(sql, subId, f);
  } catch (err) {
    // registerWebhook's contract: never throw, always return { verified: false, error }.
    return { verified: false, error: err instanceof Error ? err.message : String(err) };
  }
  return undefined;
}
