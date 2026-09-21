import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { testSql, resetDb, TEST_DB_URL } from './helpers.js';
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

  it('no_delivery detail names the silent target', async () => {
    await sql`update announcements set published_at = now() - interval '2 hours' where id = 'ann_h'`;
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status)
      values ('ann_h', 1, 'publish', 'discord', 'discord:mainnet-updates', 'failed')`;
    const issues = await evaluateChannelHealth(sql);
    const silent = issues.find(i => i.kind === 'no_delivery');
    expect(silent?.detail).toBe('no successful delivery on discord (discord:mainnet-updates) yet');
  });

  it('reports a delivered row whose publish step failed, and not one that published or was skipped', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, delivered_at, publish_note)
      values ('ann_h', 1, 'publish', 'discord', 'd1', 'delivered', now(), 'failed: crosspost HTTP 403')`;
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, delivered_at, publish_note)
      values ('ann_h', 1, 'publish', 'discord', 'd2', 'delivered', now(), 'published')`;
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, delivered_at, publish_note)
      values ('ann_h', 1, 'publish', 'discord', 'd3', 'delivered', now(), 'skipped: no bot token')`;
    const issues = await evaluateChannelHealth(sql);
    const pf = issues.filter(i => i.kind === 'publish_failed');
    expect(pf).toHaveLength(1);
    expect(pf[0]).toMatchObject({ channel: 'discord', target: 'd1' });
    expect(pf[0].detail).toBe('delivered to d1 but not published to following servers: crosspost HTTP 403');
  });

  it('a delivered row with publish_note "already published" raises no publish_failed issue', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, delivered_at, publish_note)
      values ('ann_h', 1, 'publish', 'discord', 'd1', 'delivered', now(), 'already published')`;
    expect((await evaluateChannelHealth(sql)).filter(i => i.kind === 'publish_failed')).toEqual([]);
  });

  it('ignores a failed publish older than the window', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, delivered_at, publish_note)
      values ('ann_h', 1, 'publish', 'discord', 'd1', 'delivered', now() - interval '48 hours', 'failed: crosspost HTTP 403')`;
    expect((await evaluateChannelHealth(sql)).filter(i => i.kind === 'publish_failed')).toEqual([]);
  });

  it('does not throw on a database without migration 020, and still reports an exhausted row', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, attempts, last_error)
      values ('ann_h', 1, 'publish', 'signal', 'signal:main', 'exhausted', 5, 'gone')`;
    await sql`alter table delivery_ledger drop column publish_note`;
    // A dedicated, non-prepared connection: postgres.js can cache a prepared
    // plan from the shared `sql` fixture that predates this `alter table`, so
    // open a fresh one afterward, the way a freshly-deployed process would.
    const noPrepSql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const issues = await evaluateChannelHealth(noPrepSql);
      expect(issues.some(i => i.kind === 'exhausted' && i.channel === 'signal')).toBe(true);
      expect(issues.some(i => i.kind === 'publish_failed')).toBe(false);
    } finally {
      await noPrepSql.end();
      await sql`alter table delivery_ledger add column publish_note text`;
    }
  });
});
