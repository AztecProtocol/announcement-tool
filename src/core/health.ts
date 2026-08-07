import type { Sql } from 'postgres';

export interface HealthIssue {
  kind: 'exhausted' | 'no_delivery';
  channel: string;
  announcementId: string;
  detail: string;
}

export async function evaluateChannelHealth(sql: Sql, sinceHours = 24): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];

  const exhausted = await sql`select announcement_id, channel, target, last_error from delivery_ledger
    where status = 'exhausted' and next_attempt_at > now() - make_interval(hours => ${sinceHours})`;
  for (const r of exhausted) {
    issues.push({
      kind: 'exhausted', channel: r.channel as string, announcementId: r.announcement_id as string,
      detail: `target ${r.target} exhausted retries: ${r.last_error ?? 'unknown error'}`,
    });
  }

  const silent = await sql`
    select l.announcement_id, l.channel
    from delivery_ledger l
    join announcements a on a.id = l.announcement_id and a.revision = l.revision
    where a.status = 'published' and a.published_at > now() - make_interval(hours => ${sinceHours})
    group by l.announcement_id, l.channel
    having count(*) filter (where l.status = 'delivered') = 0
       and count(*) filter (where l.status = 'exhausted') < count(*)`;
  for (const r of silent) {
    issues.push({
      kind: 'no_delivery', channel: r.channel as string, announcementId: r.announcement_id as string,
      detail: `no successful delivery on ${r.channel} yet`,
    });
  }
  return issues;
}
