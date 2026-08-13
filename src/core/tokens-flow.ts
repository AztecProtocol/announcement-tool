import type { Sql } from 'postgres';
import { getSubscriptionByUnsubscribeToken, updateSubscriptionFilters, type SubscriptionFilters } from './subscriptions.js';

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
  // updateSubscriptionFilters throws on the empty-array guard; that must happen
  // before the lookup so a malformed request fails the same way regardless of
  // whether the token is valid (this caller's contract: throw, don't swallow).
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) && v.length === 0) throw new Error(`filter ${k} must not be empty`);
  }
  const sub = await getSubscriptionByUnsubscribeToken(sql, token);
  if (!sub) return false;
  await updateSubscriptionFilters(sql, sub.id, f);
  return true;
}
