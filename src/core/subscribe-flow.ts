import type { Sql } from 'postgres';
import type { EmailSender } from '../adapters/esp.js';
import {
  createSubscription, getSubscriptionByVerifyToken, updateSubscriptionFilters, verifySubscription,
  type Subscription, type SubscriptionFilters,
} from './subscriptions.js';
import { newToken } from './ids.js';

function base(baseUrl?: string): string {
  return (baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://announce.aztec.foundation').replace(/\/+$/, '');
}

async function sendConfirmation(sender: EmailSender, email: string, token: string, baseUrl?: string): Promise<void> {
  const link = `${base(baseUrl)}/confirm/${token}`;
  await sender.send({
    to: email,
    subject: 'Confirm your Aztec announcements subscription',
    text: `Confirm your subscription to Aztec release announcements by opening this link:\n\n${link}\n\nIf you did not request this, ignore this email — nothing will be sent to you.\n`,
  });
}

async function sendConfirmChange(sender: EmailSender, email: string, token: string, baseUrl?: string): Promise<void> {
  const link = `${base(baseUrl)}/confirm-change/${token}`;
  await sender.send({
    to: email,
    subject: 'Confirm your Aztec announcements preference change',
    text: `Confirm the change to your Aztec release announcement preferences by opening this link:\n\n${link}\n\nIf you did not request this, ignore this email — your current preferences stay in effect.\n`,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/**
 * Handles the case where a row for this email already exists: update filters,
 * and either notify (verified) or (re-)send the confirmation link (unverified).
 * Shared by the initial existing-row check and the concurrent-insert fallback below.
 *
 * `attempt` bounds the row-vanished-mid-catch retry to a single hop back into
 * startEmailSubscription: if the row is gone even on that retry (e.g. a second
 * concurrent unsubscribe/delete), we give up waiting for an existing row and
 * fall through to a final create attempt instead of recursing indefinitely.
 */
async function updateExistingAndNotify(
  sql: Sql, sender: EmailSender,
  input: { email: string; filters?: Partial<SubscriptionFilters>; baseUrl?: string; createSubscriptionImpl?: typeof createSubscription },
  attempt = 0,
): Promise<'confirmation_sent' | 'updated' | 'change_pending'> {
  const existing = await sql`select id, verified, verify_token from subscriptions
    where channel = 'email' and endpoint = ${input.email}`;
  if (!existing[0]) {
    if (attempt === 0) {
      // Row vanished between the caller's insert-conflict and this re-select
      // (e.g. concurrent unsubscribe/delete). Retry once via the normal entry
      // point, which will either find a row created since or create a fresh one.
      return startEmailSubscription(sql, sender, input, attempt + 1);
    }
    // Vanished again on the retry: stop chasing the row and create fresh.
    const doCreate = input.createSubscriptionImpl ?? createSubscription;
    const sub = await doCreate(sql, { channel: 'email', endpoint: input.email, filters: input.filters });
    await sendConfirmation(sender, input.email, sub.verifyToken, input.baseUrl);
    return 'confirmation_sent';
  }
  if (existing[0].verified) {
    // Verified addresses are real people who could have their preferences
    // silently changed by anyone who knows the address (filters carry no
    // secret). Require a confirm-change click before applying anything.
    if (input.filters) {
      const pendingToken = newToken();
      await sql`update subscriptions set pending_filters = ${sql.json(input.filters)}, pending_token = ${pendingToken}
        where id = ${existing[0].id}`;
      await sendConfirmChange(sender, input.email, pendingToken, input.baseUrl);
      return 'change_pending';
    }
    await sender.send({
      to: input.email,
      subject: 'Your Aztec announcements preferences were updated',
      text: `Your subscription preferences were updated. Manage them any time from the link in any announcement email.\n`,
    });
    return 'updated';
  }
  // Unverified addresses have never proven ownership yet, so filter changes
  // (and the address itself) aren't trusted regardless — applying immediately
  // and re-sending the confirm link keeps today's behavior.
  await updateSubscriptionFilters(sql, existing[0].id as string, input.filters ?? {});
  await sendConfirmation(sender, input.email, existing[0].verify_token as string, input.baseUrl);
  return 'confirmation_sent';
}

export async function startEmailSubscription(
  sql: Sql, sender: EmailSender,
  input: {
    email: string; filters?: Partial<SubscriptionFilters>; baseUrl?: string;
    // Injectable in place of the real createSubscription — used by tests to
    // simulate the concurrent-insert race (create the row, then throw 23505)
    // without fighting ESM module mocking.
    createSubscriptionImpl?: typeof createSubscription;
  },
  attempt = 0,
): Promise<'confirmation_sent' | 'updated' | 'change_pending'> {
  const doCreate = input.createSubscriptionImpl ?? createSubscription;
  const existing = await sql`select id, verified, verify_token from subscriptions
    where channel = 'email' and endpoint = ${input.email}`;
  if (existing[0]) {
    return updateExistingAndNotify(sql, sender, input, attempt);
  }
  try {
    const sub = await doCreate(sql, { channel: 'email', endpoint: input.email, filters: input.filters });
    await sendConfirmation(sender, input.email, sub.verifyToken, input.baseUrl);
    return 'confirmation_sent';
  } catch (err) {
    // Concurrent insert for the same (channel, endpoint) lost the race to another
    // request between our select and our insert. Fall through to the
    // already-exists handling rather than letting the unique-violation propagate
    // — startEmailSubscription must never throw for "already exists".
    if (!isUniqueViolation(err)) throw err;
    return updateExistingAndNotify(sql, sender, input, attempt);
  }
}

export async function confirmSubscription(sql: Sql, token: string): Promise<Subscription | undefined> {
  const sub = await getSubscriptionByVerifyToken(sql, token);
  if (!sub) return undefined;
  await verifySubscription(sql, sub.id);
  return { ...sub, verified: true };
}

export async function confirmFilterChange(sql: Sql, token: string): Promise<boolean> {
  const rows = await sql`select id, pending_filters from subscriptions where pending_token = ${token}`;
  if (!rows[0]) return false;
  const f = rows[0].pending_filters as Partial<SubscriptionFilters>;
  await updateSubscriptionFilters(sql, rows[0].id as string, f);
  await sql`update subscriptions set pending_filters = null, pending_token = null where id = ${rows[0].id}`;
  return true;
}
