import type { Sql, TransactionSql } from 'postgres';
import type { Announcement, AnnouncementInput } from './types.js';
import { newAnnouncementId, makeSlug } from './ids.js';
import { validateAnnouncement } from './validate.js';

export function rowToAnnouncement(r: Record<string, unknown>): Announcement {
  return {
    id: r.id as string, revision: r.revision as number, slug: r.slug as string,
    type: r.type as Announcement['type'], networks: r.networks as Announcement['networks'],
    audiences: r.audiences as Announcement['audiences'], severity: r.severity as Announcement['severity'],
    title: r.title as string, bodyMd: r.body_md as string,
    actionsRequired: r.actions_required as Announcement['actionsRequired'],
    links: r.links as Announcement['links'],
    status: r.status as Announcement['status'],
    supersedes: (r.supersedes as string | null) ?? undefined,
    expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : undefined,
    createdBy: r.created_by as string,
    publishRequestedBy: (r.publish_requested_by as string | null) ?? undefined,
    publishConfirmedBy: (r.publish_confirmed_by as string | null) ?? undefined,
    publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : undefined,
  };
}

type Tx = Sql | TransactionSql;

async function insertRevision(
  tx: Tx, id: string, revision: number, slug: string, input: AnnouncementInput,
  status: Announcement['status'], actor: string, auditAction: string,
): Promise<Announcement> {
  const [row] = await tx`insert into announcements
    (id, revision, slug, type, networks, audiences, severity, title, body_md,
     actions_required, links, status, supersedes, expires_at, created_by)
    values (${id}, ${revision}, ${slug}, ${input.type}, ${input.networks}, ${input.audiences},
            ${input.severity}, ${input.title}, ${input.bodyMd},
            ${JSON.stringify(input.actionsRequired)}, ${JSON.stringify(input.links)},
            ${status}, ${input.supersedes ?? null}, ${input.expiresAt ?? null}, ${actor})
    returning *`;
  await tx`insert into audit_log (actor, action, target, detail)
    values (${actor}, ${auditAction}, ${id}, ${JSON.stringify({ revision })})`;
  return rowToAnnouncement(row);
}

export async function createDraft(sql: Sql, input: AnnouncementInput, actor: string): Promise<Announcement> {
  validateAnnouncement(input);
  const id = newAnnouncementId();
  const slug = makeSlug(new Date(), input.type, input.title);
  return sql.begin(tx => insertRevision(tx, id, 1, slug, input, 'draft', actor, 'draft_created'));
}

export async function reviseDraft(sql: Sql, id: string, input: AnnouncementInput, actor: string): Promise<Announcement> {
  validateAnnouncement(input);
  return sql.begin(async tx => {
    const [prev] = await tx`select revision, slug from announcements where id = ${id} order by revision desc limit 1`;
    if (!prev) throw new Error(`announcement not found: ${id}`);
    return insertRevision(tx, id, (prev.revision as number) + 1, prev.slug as string, input, 'draft', actor, 'edited');
  });
}

export async function getLatest(sql: Sql, id: string): Promise<Announcement | undefined> {
  const rows = await sql`select * from announcements where id = ${id} order by revision desc limit 1`;
  return rows[0] ? rowToAnnouncement(rows[0]) : undefined;
}
