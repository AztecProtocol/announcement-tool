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

export async function startEmailSubscription(
  sql: Sql, sender: EmailSender,
  input: { email: string; filters?: Partial<SubscriptionFilters>; baseUrl?: string },
): Promise<'confirmation_sent' | 'updated'> {
  const existing = await sql`select id, verified, verify_token from subscriptions
    where channel = 'email' and endpoint = ${input.email}`;
  if (existing[0]) {
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
  const sub = await createSubscription(sql, { channel: 'email', endpoint: input.email, filters: input.filters });
  await sendConfirmation(sender, input.email, sub.verifyToken, input.baseUrl);
  return 'confirmation_sent';
}

export async function confirmSubscription(sql: Sql, token: string): Promise<Subscription | undefined> {
  const sub = await getSubscriptionByVerifyToken(sql, token);
  if (!sub) return undefined;
  await verifySubscription(sql, sub.id);
  return { ...sub, verified: true };
}
