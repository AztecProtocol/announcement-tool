import type { Sql } from 'postgres';
import type { Announcement } from './types.js';
import { rowToAnnouncement } from './announcements.js';

/** Latest revision per id, published only, newest first. */
export async function listPublished(sql: Sql, limit = 50): Promise<Announcement[]> {
  const rows = await sql`
    select * from (
      select distinct on (id) * from announcements order by id, revision desc
    ) latest
    where latest.status = 'published'
    order by latest.published_at desc, latest.id desc
    limit ${limit}`;
  return rows.map(rowToAnnouncement);
}

/**
 * Announcements awaiting a second publisher's confirmation.
 *
 * Uses distinct-on to read each announcement's LATEST revision before filtering
 * on status — a `where status = 'publish_requested'` over all rows would match
 * a superseded revision of an announcement that has since moved on.
 */
export async function listAwaitingConfirmation(sql: Sql): Promise<Announcement[]> {
  const rows = await sql`
    select * from (
      select distinct on (id) * from announcements order by id, revision desc
    ) latest
    where latest.status = 'publish_requested'
    order by latest.created_at desc`;
  return rows.map(rowToAnnouncement);
}

export async function getPublishedBySlug(sql: Sql, slug: string): Promise<Announcement | undefined> {
  const rows = await sql`
    select * from (
      select distinct on (id) * from announcements where slug = ${slug} order by id, revision desc
    ) latest
    where latest.status = 'published'
    limit 1`;
  return rows[0] ? rowToAnnouncement(rows[0]) : undefined;
}
