import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import {
  createDraft, requestPublish, reviseDraft, discardDraft, getLatest,
} from '../src/core/announcements.js';
import { safeErrorMessage } from '../app/admin/safe-error-message.js';
import { editPrefillFromAnnouncement } from '../app/admin/parse-from.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const info = (title: string): AnnouncementInput => ({
  type: 'info', networks: ['mainnet'], audiences: ['operators'], severity: 'info',
  title, bodyMd: 'Body.', actionsRequired: [], links: [],
});
const critical = (title: string): AnnouncementInput => ({ ...info(title), severity: 'critical' });

describe('reviseDraft status guard', () => {
  it('revises a draft', async () => {
    const a = await createDraft(sql, info('Original'), 'alice@test.local');
    const out = await reviseDraft(sql, a.id, info('Edited'), 'alice@test.local');
    expect(out.title).toBe('Edited');
    expect(out.status).toBe('draft');
    expect(out.revision).toBe(a.revision + 1);
  });

  it('refuses to revise a published announcement', async () => {
    // This is the four-eyes bypass the guard exists to close: a published
    // announcement has already gone to five channels and has a live page.
    const a = await createDraft(sql, info('Goes out'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local'); // info publishes immediately
    await expect(reviseDraft(sql, a.id, info('Rewritten'), 'alice@test.local')).rejects.toThrow();
    const after = await getLatest(sql, a.id);
    expect(after?.status).toBe('published');
    expect(after?.title).toBe('Goes out');
  });

  it('refuses to revise an announcement awaiting confirmation', async () => {
    const a = await createDraft(sql, critical('Awaiting'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    await expect(reviseDraft(sql, a.id, critical('Sneaky'), 'alice@test.local')).rejects.toThrow();
  });

  it('keeps the slug across a revision', async () => {
    const a = await createDraft(sql, info('Original'), 'alice@test.local');
    const out = await reviseDraft(sql, a.id, info('Edited'), 'alice@test.local');
    expect(out.slug).toBe(a.slug);
  });

  it('writes an audit row', async () => {
    const a = await createDraft(sql, info('Original'), 'alice@test.local');
    await reviseDraft(sql, a.id, info('Edited'), 'bob@test.local');
    const rows = await sql`select * from audit_log where target = ${a.id} and action = 'edited'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('bob@test.local');
  });

  it('keeps the id and slug across an edit', async () => {
    const a = await createDraft(sql, info('Original'), 'alice@test.local');
    const out = await reviseDraft(sql, a.id, { ...info('Edited'), slug: a.slug }, 'alice@test.local');
    expect(out.id).toBe(a.id);
    expect(out.slug).toBe(a.slug);
    expect(out.revision).toBe(a.revision + 1);
  });

  // saveRevisionAction (app/admin/actions.ts) is the four-eyes backstop at the
  // action layer for the edit route: it calls reviseDraft inside a try/catch
  // and surfaces the guard's error through safeErrorMessage, so an author who
  // reaches it on a non-draft (e.g. a stale edit link to something published
  // in another tab) sees a real message instead of an unhandled throw.
  // saveRevisionAction itself cannot be called directly from a plain vitest
  // test — it calls headers() via next/dist/server/request/headers.js, which
  // requires a Next.js request context this test runner doesn't provide. That
  // is the same reason no other app/admin/actions.ts export has a direct
  // unit test in this suite (see safe-error-message.test.ts, which tests the
  // mapping function in isolation instead). This test exercises the same two
  // pieces saveRevisionAction composes — reviseDraft's guard and
  // safeErrorMessage's mapping of it — end to end, without the Next.js
  // request context saveRevisionAction additionally needs.
  it('maps reviseDraft\'s guard on a published announcement to a real message via safeErrorMessage, as saveRevisionAction does', async () => {
    const a = await createDraft(sql, info('Goes out'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local'); // info publishes immediately
    let caught: unknown;
    try {
      await reviseDraft(sql, a.id, info('Sneaky edit'), 'alice@test.local');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = safeErrorMessage(caught, 'reviseDraft');
    expect(message).toMatch(/only a draft can be edited/);
    expect(message).not.toBe('Something went wrong — check the server logs.');
  });

  it('retains mentionRoleIds through editPrefillFromAnnouncement for a real stored draft, so edit mode seeds the same selection it was saved with', async () => {
    const withRoles: AnnouncementInput = { ...critical('Needs roles'), mentionRoleIds: ['role-a', 'role-b'] };
    const a = await createDraft(sql, withRoles, 'alice@test.local');
    const latest = await getLatest(sql, a.id);
    expect(latest).toBeDefined();
    const prefill = editPrefillFromAnnouncement(latest!);
    expect(prefill.mentionRoleIds).toEqual(['role-a', 'role-b']);
  });
});

describe('discardDraft', () => {
  it('moves a draft to discarded', async () => {
    const a = await createDraft(sql, info('Bin me'), 'alice@test.local');
    const out = await discardDraft(sql, a.id, 'alice@test.local');
    expect(out.status).toBe('discarded');
  });

  it('keeps the row', async () => {
    const a = await createDraft(sql, info('Bin me'), 'alice@test.local');
    await discardDraft(sql, a.id, 'alice@test.local');
    const rows = await sql`select id from announcements where id = ${a.id}`;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses to discard a published announcement', async () => {
    const a = await createDraft(sql, info('Published'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    await expect(discardDraft(sql, a.id, 'alice@test.local')).rejects.toThrow();
  });

  it('refuses to discard an announcement awaiting confirmation', async () => {
    // Discarding out from under a pending review would remove the announcement
    // from the other publisher's queue without their knowledge, so it is refused:
    // withdraw or reject it first, then discard the resulting draft.
    const a = await createDraft(sql, critical('Awaiting'), 'alice@test.local');
    await requestPublish(sql, a.id, 'alice@test.local');
    await expect(discardDraft(sql, a.id, 'alice@test.local')).rejects.toThrow();
  });

  it('refuses to discard twice', async () => {
    const a = await createDraft(sql, info('Bin me'), 'alice@test.local');
    await discardDraft(sql, a.id, 'alice@test.local');
    await expect(discardDraft(sql, a.id, 'alice@test.local')).rejects.toThrow();
  });

  it('writes an audit row', async () => {
    const a = await createDraft(sql, info('Bin me'), 'alice@test.local');
    await discardDraft(sql, a.id, 'bob@test.local');
    const rows = await sql`select * from audit_log where target = ${a.id} and action = 'draft_discarded'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('bob@test.local');
  });

  it('cannot be revised after discarding', async () => {
    const a = await createDraft(sql, info('Bin me'), 'alice@test.local');
    await discardDraft(sql, a.id, 'alice@test.local');
    await expect(reviseDraft(sql, a.id, info('Back from the dead'), 'alice@test.local')).rejects.toThrow();
  });
});
