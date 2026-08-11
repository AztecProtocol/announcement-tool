import type { Sql } from 'postgres';
import { getSubscriptionByUnsubscribeToken, type SubscriptionFilters } from './subscriptions.js';

export async function unsubscribeByToken(sql: Sql, token: string): Promise<boolean> {
  const sub = await getSubscriptionByUnsubscribeToken(sql, token);
  if (!sub) return false;
  await sql.begin(async tx => {
    await tx`delete from subscriptions where id = ${sub.id}`;
    await tx`insert into audit_log (actor, action, target, detail)
      values ('subscriber', 'subscription_deleted', ${sub.id}, ${tx.json({ channel: sub.channel })})`;
  });
  return true;
}

export async function updateFiltersByToken(
  sql: Sql, token: string, f: Partial<SubscriptionFilters>,
): Promise<boolean> {
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) && v.length === 0) throw new Error(`filter ${k} must not be empty`);
  }
  const sub = await getSubscriptionByUnsubscribeToken(sql, token);
  if (!sub) return false;
  if (f.networks) await sql`update subscriptions set filter_networks = ${f.networks} where id = ${sub.id}`;
  if (f.types) await sql`update subscriptions set filter_types = ${f.types} where id = ${sub.id}`;
  if (f.severities) await sql`update subscriptions set filter_severities = ${f.severities} where id = ${sub.id}`;
  if (f.audiences) await sql`update subscriptions set filter_audiences = ${f.audiences} where id = ${sub.id}`;
  return true;
}
