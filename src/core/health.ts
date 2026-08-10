import type { Sql } from 'postgres';

export interface HealthIssue {
  kind: 'exhausted' | 'no_delivery';
  channel: string;
  target: string;
  announcementId: string;
  revision: number;
  detail: string;
}

export async function evaluateChannelHealth(sql: Sql, sinceHours = 24): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];

  // This window works because next_attempt_at is set to roughly (exhaustion time + final
  // backoff) by fanout.ts when a row exhausts, and is never touched again afterward — so
  // it stays a static, comparable timestamp for "was this exhausted recently."
  const exhausted = await sql`select announcement_id, revision, channel, target, last_error from delivery_ledger
    where status = 'exhausted' and next_attempt_at > now() - make_interval(hours => ${sinceHours})`;
  for (const r of exhausted) {
    issues.push({
      kind: 'exhausted', channel: r.channel as string, target: r.target as string,
      announcementId: r.announcement_id as string, revision: r.revision as number,
      detail: `target ${r.target} exhausted retries: ${r.last_error ?? 'unknown error'}`,
    });
  }

  // The grace period matters: a freshly published announcement has all-pending rows, which
  // would otherwise trip "no successful delivery" before the retry ladder (2+5+10+20 ≈ 37min)
  // has had a real chance to succeed. Since alerting is one-shot-per-key, firing early would
  // burn the key and permanently suppress the genuine "still nothing delivered" condition.
  const silent = await sql`
    select l.announcement_id, l.revision, l.channel, l.target
    from delivery_ledger l
    join announcements a on a.id = l.announcement_id and a.revision = l.revision
    where a.status = 'published' and a.published_at > now() - make_interval(hours => ${sinceHours})
      and a.published_at < now() - interval '30 minutes'
    group by l.announcement_id, l.revision, l.channel, l.target
    having count(*) filter (where l.status = 'delivered') = 0
       and count(*) filter (where l.status = 'exhausted') < count(*)`;
  for (const r of silent) {
    issues.push({
      kind: 'no_delivery', channel: r.channel as string, target: r.target as string,
      announcementId: r.announcement_id as string, revision: r.revision as number,
      detail: `no successful delivery on ${r.channel} yet`,
    });
  }
  return issues;
}
