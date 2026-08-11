import type { Sql } from 'postgres';
import type { EmailSender } from '../adapters/esp.js';
import {
  createSubscription, getSubscriptionByVerifyToken, verifySubscription,
  type Subscription, type SubscriptionFilters,
} from './subscriptions.js';

function base(baseUrl?: string): string {
  return (baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://announce.aztec.foundation').replace(/\/+$/, '');
}

async function updateFilters(sql: Sql, id: string, f?: Partial<SubscriptionFilters>): Promise<void> {
  if (!f) return;
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) && v.length === 0) throw new Error(`filter ${k} must not be empty`);
  }
  if (f.networks) await sql`update subscriptions set filter_networks = ${f.networks} where id = ${id}`;
  if (f.types) await sql`update subscriptions set filter_types = ${f.types} where id = ${id}`;
  if (f.severities) await sql`update subscriptions set filter_severities = ${f.severities} where id = ${id}`;
  if (f.audiences) await sql`update subscriptions set filter_audiences = ${f.audiences} where id = ${id}`;
}

async function sendConfirmation(sender: EmailSender, email: string, token: string, baseUrl?: string): Promise<void> {
  const link = `${base(baseUrl)}/confirm/${token}`;
  await sender.send({
    to: email,
    subject: 'Confirm your Aztec announcements subscription',
    text: `Confirm your subscription to Aztec release announcements by opening this link:\n\n${link}\n\nIf you did not request this, ignore this email — nothing will be sent to you.\n`,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/**
 * Handles the case where a row for this email already exists: update filters,
 * and either notify (verified) or (re-)send the confirmation link (unverified).
 * Shared by the initial existing-row check and the concurrent-insert fallback below.
 */
async function updateExistingAndNotify(
  sql: Sql, sender: EmailSender,
  input: { email: string; filters?: Partial<SubscriptionFilters>; baseUrl?: string },
): Promise<'confirmation_sent' | 'updated'> {
  const existing = await sql`select id, verified, verify_token from subscriptions
    where channel = 'email' and endpoint = ${input.email}`;
  if (!existing[0]) {
    // Row vanished between the caller's insert-conflict and this re-select
    // (e.g. concurrent unsubscribe/delete). Treat as a fresh signup.
    return startEmailSubscription(sql, sender, input);
  }
  await updateFilters(sql, existing[0].id as string, input.filters);
  if (existing[0].verified) {
    await sender.send({
      to: input.email,
      subject: 'Your Aztec announcements preferences were updated',
      text: `Your subscription preferences were updated. Manage them any time from the link in any announcement email.\n`,
    });
    return 'updated';
  }
  await sendConfirmation(sender, input.email, existing[0].verify_token as string, input.baseUrl);
  return 'confirmation_sent';
}

export async function startEmailSubscription(
  sql: Sql, sender: EmailSender,
  input: { email: string; filters?: Partial<SubscriptionFilters>; baseUrl?: string },
): Promise<'confirmation_sent' | 'updated'> {
  const existing = await sql`select id, verified, verify_token from subscriptions
    where channel = 'email' and endpoint = ${input.email}`;
  if (existing[0]) {
    return updateExistingAndNotify(sql, sender, input);
  }
  try {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: input.email, filters: input.filters });
    await sendConfirmation(sender, input.email, sub.verifyToken, input.baseUrl);
    return 'confirmation_sent';
  } catch (err) {
    // Concurrent insert for the same (channel, endpoint) lost the race to another
    // request between our select and our insert. Fall through to the
    // already-exists handling rather than letting the unique-violation propagate
    // — startEmailSubscription must never throw for "already exists".
    if (!isUniqueViolation(err)) throw err;
    return updateExistingAndNotify(sql, sender, input);
  }
}

export async function confirmSubscription(sql: Sql, token: string): Promise<Subscription | undefined> {
  const sub = await getSubscriptionByVerifyToken(sql, token);
  if (!sub) return undefined;
  await verifySubscription(sql, sub.id);
  return { ...sub, verified: true };
}
