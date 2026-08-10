import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { evaluateChannelHealth } from '../src/core/health.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => {
  await resetDb(sql);
  await sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by, published_at)
    values ('ann_h', 1, 's', 'upgrade', '{mainnet}', '{operators}', 'critical', 't', 'b', 'published', 'a@x', now())`;
});
afterAll(async () => { await sql.end(); });

describe('evaluateChannelHealth', () => {
  it('reports exhausted rows', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, attempts, last_error)
      values ('ann_h', 1, 'publish', 'signal', 'signal:main', 'exhausted', 5, 'gone')`;
    const issues = await evaluateChannelHealth(sql);
    expect(issues).toEqual([
      {
        kind: 'exhausted', channel: 'signal', target: 'signal:main', announcementId: 'ann_h', revision: 1,
        detail: expect.stringContaining('gone'),
      },
    ]);
  });

  it('reports channels with zero delivered rows for a published announcement', async () => {
    await sql`update announcements set published_at = now() - interval '2 hours' where id = 'ann_h' and revision = 1`;
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status)
      values ('ann_h', 1, 'publish', 'telegram', 'telegram:main', 'failed')`;
    const issues = await evaluateChannelHealth(sql);
    expect(issues.some(i => i.kind === 'no_delivery' && i.channel === 'telegram')).toBe(true);
  });

  it('is quiet when everything delivered', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, delivered_at)
      values ('ann_h', 1, 'publish', 'telegram', 'telegram:main', 'delivered', now())`;
    expect(await evaluateChannelHealth(sql)).toEqual([]);
  });

  it('does not report no_delivery on the first tick after publish, only after a grace period', async () => {
    // Freshly published: all rows still pending, nothing has had a chance to attempt yet.
    await sql`update announcements set published_at = now() where id = 'ann_h' and revision = 1`;
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status)
      values ('ann_h', 1, 'publish', 'telegram', 'telegram:main', 'pending')`;
    const freshIssues = await evaluateChannelHealth(sql);
    expect(freshIssues.some(i => i.kind === 'no_delivery')).toBe(false);

    // Published 2 hours ago, still nothing delivered: the retry ladder has long since had
    // its chance, so this is a genuine no_delivery condition.
    await sql`update announcements set published_at = now() - interval '2 hours' where id = 'ann_h' and revision = 1`;
    const staleIssues = await evaluateChannelHealth(sql);
    expect(staleIssues.some(i => i.kind === 'no_delivery' && i.channel === 'telegram')).toBe(true);
  });
});
