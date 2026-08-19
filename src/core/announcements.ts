import type { Sql, TransactionSql, JSONValue } from 'postgres';
import type { Announcement, AnnouncementInput } from './types.js';
import { newAnnouncementId, makeSlug } from './ids.js';
import { validateAnnouncement } from './validate.js';
import { enqueueDeliveries } from './outbox.js';

// `sql.json()` wants postgres's structural JSONValue type, which readonly array/interface
// shapes (like ActionRequired[]/Link[]) don't satisfy nominally even though they're valid
// JSON at runtime. This cast documents that gap instead of silently widening to `any`.
function asJson<T>(value: T): JSONValue {
  return value as unknown as JSONValue;
}

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
    createdBy: r.created_by as string,
    publishRequestedBy: (r.publish_requested_by as string | null) ?? undefined,
    publishConfirmedBy: (r.publish_confirmed_by as string | null) ?? undefined,
    publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : undefined,
    scheduledFor: r.scheduled_for ? new Date(r.scheduled_for as string).toISOString() : undefined,
    publishRejectedBy: (r.publish_rejected_by as string | null) ?? undefined,
    publishRejectedReason: (r.publish_rejected_reason as string | null) ?? undefined,
    mentionRoleIds: (r.mention_role_ids as string[] | null) ?? undefined,
  };
}

type Tx = Sql | TransactionSql;

async function insertRevision(
  tx: Tx, id: string, revision: number, slug: string, input: AnnouncementInput,
  status: Announcement['status'], actor: string, auditAction: string,
): Promise<Announcement> {
  const [row] = await tx`insert into announcements
    (id, revision, slug, type, networks, audiences, severity, title, body_md,
     actions_required, links, status, supersedes, created_by, mention_role_ids)
    values (${id}, ${revision}, ${slug}, ${input.type}, ${input.networks}, ${input.audiences},
            ${input.severity}, ${input.title}, ${input.bodyMd},
            ${tx.json(asJson(input.actionsRequired))}, ${tx.json(asJson(input.links))},
            ${status}, ${input.supersedes ?? null}, ${actor},
            ${input.mentionRoleIds ?? null})
    returning *`;
  await tx`insert into audit_log (actor, action, target, detail)
    values (${actor}, ${auditAction}, ${id}, ${tx.json({ revision })})`;
  return rowToAnnouncement(row);
}

export async function createDraft(sql: Sql, input: AnnouncementInput, actor: string): Promise<Announcement> {
  validateAnnouncement(input);
  const id = newAnnouncementId();
  const base = input.slug || makeSlug(new Date(), input.type, input.title);
  return sql.begin(async tx => {
    let slug: string | undefined;
    for (let i = 1; i <= 20; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      const taken = await tx`select 1 from announcements where slug = ${candidate} limit 1`;
      if (!taken[0]) { slug = candidate; break; }
    }
    if (!slug) throw new Error(`could not find a free slug for "${base}" after 20 attempts`);
    return insertRevision(tx, id, 1, slug, input, 'draft', actor, 'draft_created');
  });
}

export async function reviseDraft(sql: Sql, id: string, input: AnnouncementInput, actor: string): Promise<Announcement> {
  validateAnnouncement(input);
  return sql.begin(async tx => {
    const [prev] = await tx`select revision, slug, status from announcements
      where id = ${id} order by revision desc limit 1 for update`;
    if (!prev) throw new Error(`announcement not found: ${id}`);
    if (prev.status !== 'draft') {
      throw new Error(`only a draft can be edited (status ${prev.status as string})`);
    }
    return insertRevision(tx, id, (prev.revision as number) + 1, prev.slug as string, input, 'draft', actor, 'edited');
  });
}

export async function getLatest(sql: Sql, id: string): Promise<Announcement | undefined> {
  const rows = await sql`select * from announcements where id = ${id} order by revision desc limit 1`;
  return rows[0] ? rowToAnnouncement(rows[0]) : undefined;
}

/**
 * Bin a draft that will never be published. The row and its audit trail stay —
 * the tables are the audit source of truth and never delete rows — but the
 * announcement leaves every view. Terminal: a discarded draft cannot be
 * revised, requested or discarded again.
 */
export async function discardDraft(sql: Sql, id: string, actor: string): Promise<Announcement> {
  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'draft') {
      throw new Error(`only a draft can be discarded (status ${a.status})`);
    }
    const [row] = await tx`update announcements
      set status = 'discarded'
      where id = ${id} and revision = ${a.revision} returning *`;
    await tx`insert into audit_log (actor, action, target, detail)
      values (${actor}, 'draft_discarded', ${id}, ${tx.json({ revision: a.revision })})`;
    return rowToAnnouncement(row);
  });
}

export class FourEyesError extends Error {
  constructor() { super('critical announcements require confirmation by a different publisher'); }
}

async function performPublish(tx: TransactionSql, a: Announcement, confirmer: string): Promise<Announcement> {
  const [row] = await tx`update announcements
    set status = 'published', published_at = now(), publish_confirmed_by = ${confirmer}
    where id = ${a.id} and revision = ${a.revision} returning *`;
  const published = rowToAnnouncement(row);
  await enqueueDeliveries(tx, published, 'publish');
  await tx`insert into audit_log (actor, action, target, detail)
    values (${confirmer}, 'publish_confirmed', ${a.id}, ${tx.json({ revision: a.revision })})`;
  return published;
}

/**
 * Publish every scheduled announcement whose time has come. Called on the
 * worker's existing tick.
 *
 * `for update skip locked` matches the fan-out claim in src/worker/fanout.ts,
 * so two workers never send the same announcement twice.
 *
 * The status filter is the safety boundary: ONLY 'scheduled' rows are taken.
 * A draft, or a critical announcement still waiting for its second publisher,
 * is never touched — the worker cannot approve anything, it can only carry out
 * what two people already approved.
 *
 * The actor is 'scheduler' because no person performed this send. Note that
 * performPublish overwrites publish_confirmed_by with that literal, so the
 * audit detail below carries the humans who actually approved it.
 */
export async function publishDueScheduled(sql: Sql): Promise<Announcement[]> {
  return sql.begin(async tx => {
    const due = await tx`select * from announcements
      where status = 'scheduled' and scheduled_for <= now()
      order by scheduled_for
      for update skip locked`;

    const sent: Announcement[] = [];
    for (const row of due) {
      const a = rowToAnnouncement(row);
      const published = await performPublish(tx, a, 'scheduler');
      await tx`insert into audit_log (actor, action, target, detail)
        values ('scheduler', 'scheduled_publish_sent', ${a.id},
                ${tx.json({
                  revision: a.revision,
                  scheduledFor: a.scheduledFor,
                  requestedBy: a.publishRequestedBy ?? null,
                  confirmedBy: a.publishConfirmedBy ?? null,
                })})`;
      sent.push(published);
    }
    return sent;
  });
}

export async function requestPublish(sql: Sql, id: string, actor: string): Promise<Announcement> {
  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'draft') throw new Error(`cannot request publish from status ${a.status}`);
    if (a.severity !== 'critical') return performPublish(tx, a, actor);
    const [row] = await tx`update announcements
      set status = 'publish_requested', publish_requested_by = ${actor}
      where id = ${id} and revision = ${a.revision} returning *`;
    await tx`insert into audit_log (actor, action, target, detail)
      values (${actor}, 'publish_requested', ${id}, ${tx.json({ revision: a.revision })})`;
    return rowToAnnouncement(row);
  });
}

export async function confirmPublish(sql: Sql, id: string, actor: string): Promise<Announcement> {
  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'publish_requested') throw new Error(`announcement is not awaiting confirmation (status ${a.status})`);
    if (a.scheduledFor) throw new Error('this announcement is scheduled; use confirmSchedule');
    if (a.severity === 'critical' && a.publishRequestedBy === actor) throw new FourEyesError();
    return performPublish(tx, a, actor);
  });
}

/**
 * Set a future send time. Four-eyes is satisfied here, BEFORE the wait: a
 * critical announcement stops at publish_requested and needs a second
 * publisher's confirmSchedule, exactly as an immediate publish needs
 * confirmPublish. The worker later moves an already-approved row from
 * 'scheduled' to 'published'; it never approves anything itself.
 */
export async function schedulePublish(
  sql: Sql, id: string, whenIso: string, actor: string,
): Promise<Announcement> {
  const when = new Date(whenIso);
  if (Number.isNaN(when.getTime())) throw new Error('scheduled time is not a valid date');
  if (when.getTime() <= Date.now()) throw new Error('scheduled time is in the past');

  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'draft') throw new Error(`only a draft can be scheduled (status ${a.status})`);

    const next = a.severity === 'critical' ? 'publish_requested' : 'scheduled';
    const [row] = await tx`update announcements
      set status = ${next}, scheduled_for = ${when.toISOString()},
          publish_requested_by = ${a.severity === 'critical' ? actor : null}
      where id = ${id} and revision = ${a.revision} returning *`;
    await tx`insert into audit_log (actor, action, target, detail)
      values (${actor}, 'publish_scheduled', ${id},
              ${tx.json({ revision: a.revision, scheduledFor: when.toISOString(), status: next })})`;
    return rowToAnnouncement(row);
  });
}

/**
 * The second publisher approves a scheduled critical announcement. The
 * scheduled twin of confirmPublish: identical four-eyes guard, but it lands in
 * 'scheduled' instead of publishing now.
 */
export async function confirmSchedule(sql: Sql, id: string, actor: string): Promise<Announcement> {
  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'publish_requested') throw new Error(`announcement is not awaiting confirmation (status ${a.status})`);
    if (!a.scheduledFor) throw new Error('announcement has no scheduled time; use confirmPublish');
    if (a.severity === 'critical' && a.publishRequestedBy === actor) throw new FourEyesError();

    const [row] = await tx`update announcements
      set status = 'scheduled', publish_confirmed_by = ${actor}
      where id = ${id} and revision = ${a.revision} returning *`;
    await tx`insert into audit_log (actor, action, target, detail)
      values (${actor}, 'schedule_confirmed', ${id}, ${tx.json({ revision: a.revision, scheduledFor: a.scheduledFor })})`;
    return rowToAnnouncement(row);
  });
}

/**
 * Stop a pending send and return the announcement to draft.
 *
 * ANY publisher may cancel — not only the one who scheduled it. Approval was
 * given before the wait, so the only protection against circumstances changing
 * during the wait is that somebody present can stop it; requiring one specific
 * person to be available would defeat that.
 *
 * Clears publish_requested_by and publish_confirmed_by along with the time, so
 * re-scheduling needs a fresh request AND a fresh second confirmation.
 * Cancelling must never become a way around four-eyes.
 */
export async function cancelSchedule(sql: Sql, id: string, actor: string): Promise<Announcement> {
  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'scheduled' && !(a.status === 'publish_requested' && a.scheduledFor)) {
      throw new Error(`announcement is not scheduled (status ${a.status})`);
    }
    const [row] = await tx`update announcements
      set status = 'draft', scheduled_for = null, publish_requested_by = null,
          publish_confirmed_by = null, publish_rejected_by = null, publish_rejected_reason = null
      where id = ${id} and revision = ${a.revision} returning *`;
    await tx`insert into audit_log (actor, action, target, detail)
      values (${actor}, 'schedule_cancelled', ${id}, ${tx.json({ revision: a.revision, scheduledFor: a.scheduledFor })})`;
    return rowToAnnouncement(row);
  });
}

/**
 * The requester takes back their own request. Returns to draft and clears the
 * requester, so publishing again needs a fresh request and still needs a second
 * confirmer — withdrawal must never become a way around four-eyes.
 */
export async function withdrawPublish(sql: Sql, id: string, actor: string): Promise<Announcement> {
  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'publish_requested') {
      throw new Error(`announcement is not awaiting confirmation (status ${a.status})`);
    }
    if (a.publishRequestedBy !== actor) {
      throw new Error('only the publisher who requested this can withdraw it');
    }
    const [row] = await tx`update announcements
      set status = 'draft', publish_requested_by = null, scheduled_for = null,
          publish_rejected_by = null, publish_rejected_reason = null
      where id = ${id} and revision = ${a.revision} returning *`;
    await tx`insert into audit_log (actor, action, target, detail)
      values (${actor}, 'publish_withdrawn', ${id}, ${tx.json({ revision: a.revision })})`;
    return rowToAnnouncement(row);
  });
}

/**
 * A second publisher declines the request, with a reason the author will see.
 * Returns to draft. The reason is the point: four-eyes is a review, and a
 * reviewer who cannot say what is wrong can only veto silently.
 */
export async function rejectPublish(
  sql: Sql, id: string, actor: string, reason: string,
): Promise<Announcement> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('a reason is required to reject a publication');
  return sql.begin(async tx => {
    const rows = await tx`select * from announcements where id = ${id} order by revision desc limit 1 for update`;
    if (!rows[0]) throw new Error(`announcement not found: ${id}`);
    const a = rowToAnnouncement(rows[0]);
    if (a.status !== 'publish_requested') {
      throw new Error(`announcement is not awaiting confirmation (status ${a.status})`);
    }
    if (a.publishRequestedBy === actor) {
      throw new Error('you requested this publication — withdraw it instead of rejecting it');
    }
    const [row] = await tx`update announcements
      set status = 'draft', publish_requested_by = null, scheduled_for = null,
          publish_rejected_by = ${actor}, publish_rejected_reason = ${trimmed}
      where id = ${id} and revision = ${a.revision} returning *`;
    await tx`insert into audit_log (actor, action, target, detail)
      values (${actor}, 'publish_rejected', ${id}, ${tx.json({ revision: a.revision, reason: trimmed })})`;
    return rowToAnnouncement(row);
  });
}
