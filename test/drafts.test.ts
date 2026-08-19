import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import {
  createDraft, requestPublish, reviseDraft, discardDraft, getLatest,
} from '../src/core/announcements.js';
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
