import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { listPublished, getPublishedBySlug, listAwaitingConfirmation, listDrafts } from '../src/core/queries.js';
import { createDraft, requestPublish, confirmPublish, discardDraft, reviseDraft, rejectPublish } from '../src/core/announcements.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const input = (title: string): AnnouncementInput => ({
  type: 'info', networks: ['mainnet'], audiences: ['operators'], severity: 'info',
  title, bodyMd: 'Body.', actionsRequired: [], links: [],
});

const criticalInput = (title: string): AnnouncementInput => ({
  ...input(title), severity: 'critical',
});

describe('published queries', () => {
  it('lists only published announcements, newest first', async () => {
    await createDraft(sql, input('Draft only'), 'a@x'); // never published
    const one = await createDraft(sql, input('First'), 'a@x');
    await requestPublish(sql, one.id, 'a@x'); // info publishes immediately
    const two = await createDraft(sql, input('Second'), 'a@x');
    await requestPublish(sql, two.id, 'a@x');
    const list = await listPublished(sql);
    expect(list.map(a => a.title)).toEqual(['Second', 'First']);
  });

  it('a draft revision on top of a published one does not hide or resurface it wrongly', async () => {
    const one = await createDraft(sql, input('Original'), 'a@x');
    await requestPublish(sql, one.id, 'a@x');
    // reviseDraft refuses a non-draft status (see drafts.test.ts), so this
    // out-of-band state — a later draft revision layered on a published one —
    // is fabricated directly at the SQL level, exactly as the guarded function
    // used to allow it to happen. The query layer must still treat it as
    // "not currently published" regardless of how the row came to exist.
    await sql`insert into announcements
      (id, revision, slug, type, networks, audiences, severity, title, body_md,
       actions_required, links, status, created_by)
      values (${one.id}, ${one.revision + 1}, ${one.slug}, ${one.type}, ${one.networks}, ${one.audiences},
              ${one.severity}, 'Edited draft', ${one.bodyMd},
              ${sql.json([])}, ${sql.json([])}, 'draft', 'a@x')`;
    // Latest revision is a draft → the announcement is not currently published.
    expect(await listPublished(sql)).toEqual([]);
    expect(await getPublishedBySlug(sql, one.slug)).toBeUndefined();
  });

  it('finds a published announcement by slug', async () => {
    const one = await createDraft(sql, input('Findable'), 'a@x');
    await requestPublish(sql, one.id, 'a@x');
    const found = await getPublishedBySlug(sql, one.slug);
    expect(found?.id).toBe(one.id);
    expect(await getPublishedBySlug(sql, 'no-such-slug')).toBeUndefined();
  });
});

describe('listAwaitingConfirmation', () => {
  it('returns an announcement whose publish was requested', async () => {
    const a = await createDraft(sql, criticalInput('Needs a second pair of eyes'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    const rows = await listAwaitingConfirmation(sql);
    expect(rows.map(r => r.id)).toContain(a.id);
  });

  it('does not return a plain draft', async () => {
    const a = await createDraft(sql, criticalInput('Still a draft'), 'alice@test.local');
    const rows = await listAwaitingConfirmation(sql);
    expect(rows.map(r => r.id)).not.toContain(a.id);
  });

  it('does not return an announcement once it is confirmed', async () => {
    const a = await createDraft(sql, criticalInput('Will be confirmed'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    await confirmPublish(sql, a.id, 'bob@test.local');
    const rows = await listAwaitingConfirmation(sql);
    expect(rows.map(r => r.id)).not.toContain(a.id);
  });

  it('does not return a non-critical announcement, which publishes without confirmation', async () => {
    const a = await createDraft(sql, input('Routine info'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    const rows = await listAwaitingConfirmation(sql);
    expect(rows.map(r => r.id)).not.toContain(a.id);
  });

  it('reports who requested the publish', async () => {
    const a = await createDraft(sql, criticalInput('Who asked'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    const row = (await listAwaitingConfirmation(sql)).find(r => r.id === a.id);
    expect(row?.publishRequestedBy).toBe('alice@test.local');
  });
});

describe('listDrafts', () => {
  it('lists a draft', async () => {
    const a = await createDraft(sql, input('A draft'), 'a@x');
    expect((await listDrafts(sql)).map(r => r.id)).toContain(a.id);
  });

  it('does not list a published announcement', async () => {
    const a = await createDraft(sql, input('Published'), 'a@x');
    await requestPublish(sql, a.id, 'a@x');
    expect((await listDrafts(sql)).map(r => r.id)).not.toContain(a.id);
  });

  it('does not list one awaiting confirmation', async () => {
    const a = await createDraft(sql, criticalInput('Awaiting'), 'a@x');
    await requestPublish(sql, a.id, 'a@x');
    expect((await listDrafts(sql)).map(r => r.id)).not.toContain(a.id);
  });

  it('does not list a discarded draft', async () => {
    const a = await createDraft(sql, input('Binned'), 'a@x');
    await discardDraft(sql, a.id, 'a@x');
    expect((await listDrafts(sql)).map(r => r.id)).not.toContain(a.id);
  });

  it('lists a draft returned by a rejection, with its reason', async () => {
    const a = await createDraft(sql, criticalInput('Rejected'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    await rejectPublish(sql, a.id, 'bob@test.local', 'Wrong version');
    const row = (await listDrafts(sql)).find(r => r.id === a.id);
    expect(row).toBeDefined();
    expect(row?.publishRejectedReason).toBe('Wrong version');
  });

  it('reads the latest revision, not an old one', async () => {
    // An announcement whose r1 was a draft and whose r2 is published must not
    // appear — the distinct-on subquery must run before the status filter.
    const a = await createDraft(sql, input('Two revisions'), 'a@x');
    await reviseDraft(sql, a.id, input('Two revisions v2'), 'a@x');
    await requestPublish(sql, a.id, 'a@x');
    expect((await listDrafts(sql)).map(r => r.id)).not.toContain(a.id);
  });
});
