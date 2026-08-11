import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { listPublished, getPublishedBySlug } from '../src/core/queries.js';
import { createDraft, requestPublish, confirmPublish, reviseDraft } from '../src/core/announcements.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const input = (title: string): AnnouncementInput => ({
  type: 'info', networks: ['mainnet'], audiences: ['operators'], severity: 'info',
  title, bodyMd: 'Body.', actionsRequired: [], links: [],
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
    await reviseDraft(sql, one.id, input('Edited draft'), 'a@x'); // rev 2, status draft
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
