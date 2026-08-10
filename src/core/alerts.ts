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

  const fresh: HealthIssue[] = [];
  for (const issue of issues) {
    const res = await sql`insert into alert_state (key) values (${alertKey(issue)}) on conflict do nothing`;
    if (res.count > 0) fresh.push(issue);
  }
  if (fresh.length === 0) return [];

  const lines = fresh.map(i => `- [${i.channel}] ${i.kind} on ${i.announcementId}: ${i.detail}`);
  await sender.send({
    to,
    subject: `Aztec announcements: channel health — ${fresh.length} new issue${fresh.length === 1 ? '' : 's'}`,
    text: `New channel-health issues detected by the announcement worker:\n\n${lines.join('\n')}\n\nEach issue is reported once. Check the delivery ledger for detail.\n`,
  });
  await sql`update alert_state set notified_at = now() where key in ${sql(fresh.map(alertKey))}`;
  return fresh;
}
