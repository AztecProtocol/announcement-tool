import type { Sql } from 'postgres';
import type { EmailSender } from '../adapters/esp.js';
import { evaluateChannelHealth, type HealthIssue } from './health.js';

export function alertKey(issue: HealthIssue): string {
  return `${issue.kind}:${issue.channel}:${issue.announcementId}`;
}

/**
 * Evaluate channel health and email the issues we have not alerted on before.
 * The alert_state table is the dedupe: the worker calls this every tick, but a
 * given issue produces exactly one email, ever.
 */
export async function dispatchHealthAlerts(
  sql: Sql, sender: EmailSender, opts: { to?: string; sinceHours?: number } = {},
): Promise<HealthIssue[]> {
  const to = opts.to ?? process.env.ALERT_EMAIL_TO;
  if (!to) {
    console.warn('ALERT_EMAIL_TO is not set — channel-health alerts are disabled');
    return [];
  }

  const issues = await evaluateChannelHealth(sql, opts.sinceHours);
  if (issues.length === 0) return [];

  const byKey = new Map(issues.map(i => [alertKey(i), i]));
  const keys = [...byKey.keys()];

  for (const key of keys) {
    await sql`insert into alert_state (key) values (${key}) on conflict do nothing`;
  }

  // Un-notified rows are retryable: either this call just inserted the key, or a
  // previous attempt inserted it but the send never succeeded (notified_at is still
  // null). We hold the row locks (`for update skip locked`) for the lifetime of the
  // transaction — across the send itself — so a concurrent worker skips any row we've
  // already claimed instead of emailing it too. The transaction commits (persisting
  // notified_at) only if send() resolves; if it throws, the transaction rolls back and
  // notified_at stays null so the row is picked up again on a later call.
  const fresh: HealthIssue[] = [];
  await sql.begin(async (tx) => {
    const claimable = await tx`
      select key from alert_state
      where key in ${tx(keys)} and notified_at is null
      for update skip locked`;
    for (const r of claimable) {
      const issue = byKey.get(r.key as string);
      if (issue) fresh.push(issue);
    }
    if (fresh.length === 0) return;

    const lines = fresh.map(i => `- [${i.channel}] ${i.kind} on ${i.announcementId}: ${i.detail}`);
    await sender.send({
      to,
      subject: `Aztec announcements: channel health — ${fresh.length} new issue${fresh.length === 1 ? '' : 's'}`,
      text: `New channel-health issues detected by the announcement worker:\n\n${lines.join('\n')}\n\nEach issue is reported once. Check the delivery ledger for detail.\n`,
    });
    await tx`update alert_state set notified_at = now() where key in ${tx(fresh.map(alertKey))}`;
  });
  return fresh;
}
