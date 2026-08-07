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
      { kind: 'exhausted', channel: 'signal', announcementId: 'ann_h', detail: expect.stringContaining('gone') },
    ]);
  });

  it('reports channels with zero delivered rows for a published announcement', async () => {
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
});
