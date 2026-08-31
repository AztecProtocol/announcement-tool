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
 * Uses distinct-on to read each announcement's latest revision before filtering
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

/**
 * Drafts, including ones returned by a rejection — latest revision per id,
 * newest first. Uses the same distinct-on-before-filter pattern as
 * listAwaitingConfirmation: a `where status = 'draft'` over all rows would
 * match a superseded revision of an announcement that has since published.
 */
export async function listDrafts(sql: Sql, limit = 50): Promise<Announcement[]> {
  const rows = await sql`
    select * from (
      select distinct on (id) * from announcements order by id, revision desc
    ) latest
    where latest.status = 'draft'
    order by latest.created_at desc, latest.id desc
    limit ${limit}`;
  return rows.map(rowToAnnouncement);
}

/**
 * Announcements waiting for their send time — latest revision per id, soonest
 * first. Same distinct-on-before-filter pattern as listDrafts: filtering
 * without it would match a superseded revision of an announcement that has
 * since moved on.
 */
export async function listScheduled(sql: Sql, limit = 50): Promise<Announcement[]> {
  const rows = await sql`
    select * from (
      select distinct on (id) * from announcements order by id, revision desc
    ) latest
    where latest.status = 'scheduled'
    order by latest.scheduled_for asc, latest.id asc
    limit ${limit}`;
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
