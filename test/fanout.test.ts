import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { testSql, resetDb, TEST_DB_URL } from './helpers.js';
import { runFanoutOnce, MAX_ATTEMPTS } from '../src/worker/fanout.js';
import type { ChannelAdapter } from '../src/adapters/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => {
  await resetDb(sql);
  await sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by)
    values ('ann_w', 1, 's', 'upgrade', '{mainnet}', '{operators}', 'critical', 't', 'b', 'published', 'a@x')`;
  await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
    values ('ann_w', 1, 'publish', 'webhook', 'sub_1')`;
});
afterAll(async () => { await sql.end(); });

const okAdapter = (calls: string[]): ChannelAdapter => ({
  channel: 'webhook',
  deliver: async (a, target) => { calls.push(`${a.id}:${target}`); },
});
const failAdapter: ChannelAdapter = {
  channel: 'webhook',
  deliver: async () => { throw new Error('endpoint down'); },
};

describe('runFanoutOnce', () => {
  it('delivers pending rows and marks them delivered', async () => {
    const calls: string[] = [];
    const res = await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    expect(res).toEqual({ delivered: 1, failed: 0 });
    expect(calls).toEqual(['ann_w:sub_1']);
    const [row] = await sql`select status, attempts, delivered_at from delivery_ledger where target = 'sub_1'`;
    expect(row.status).toBe('delivered');
    expect(row.attempts).toBe(1);
    expect(row.delivered_at).not.toBeNull();
  });

  it('is idempotent — a delivered row is never re-sent', async () => {
    const calls: string[] = [];
    await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    expect(calls.length).toBe(1);
  });

  it('on failure: backoff scheduled, then exhausted after MAX_ATTEMPTS', async () => {
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await sql`update delivery_ledger set next_attempt_at = now() where target = 'sub_1'`;
      const res = await runFanoutOnce(sql, { webhook: failAdapter });
      expect(res.failed).toBe(1);
      const [row] = await sql`select status, attempts, last_error from delivery_ledger where target = 'sub_1'`;
      expect(row.attempts).toBe(i);
      expect(row.last_error).toContain('endpoint down');
      expect(row.status).toBe(i < MAX_ATTEMPTS ? 'failed' : 'exhausted');
      if (i < MAX_ATTEMPTS) {
        const [due] = await sql`select next_attempt_at > now() as future from delivery_ledger where target = 'sub_1'`;
        expect(due.future).toBe(true); // backed off into the future
      }
    }
    // exhausted rows are never picked up again
    await sql`update delivery_ledger set next_attempt_at = now() where target = 'sub_1'`;
    const res = await runFanoutOnce(sql, { webhook: failAdapter });
    expect(res).toEqual({ delivered: 0, failed: 0 });
  });

  it('every channel with no adapter is left pending (not crashed, not exhausted)', async () => {
    const res = await runFanoutOnce(sql, {});
    expect(res).toEqual({ delivered: 0, failed: 0 });
    const [row] = await sql`select status from delivery_ledger where target = 'sub_1'`;
    expect(row.status).toBe('pending');
  });

  it('a pending row is left untouched when its channel key maps to no adapter, not exhausted', async () => {
    // Distinct from the test above: that one passes an empty adapters map,
    // so `known` is empty and the query's `channel in ${known}` filter
    // returns zero rows — the per-row branch never runs. Here `known`
    // (Object.keys(adapters)) still includes 'webhook', so the row is
    // selected by the query; it is the per-row `adapters[row.channel]`
    // lookup that comes back falsy, exercising the loop-body branch itself.
    // buildAdapters() never produces a map shaped this way (it only sets a
    // key when it builds that adapter), but the loop body must not assume
    // that invariant — it is enforcing it defensively, and this test pins
    // that defence.
    const res = await runFanoutOnce(sql, { webhook: undefined as unknown as ChannelAdapter });
    expect(res).toEqual({ delivered: 0, failed: 0 });
    const [row] = await sql`select status, attempts, next_attempt_at from delivery_ledger where target = 'sub_1'`;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  it('stores the adapter\'s publish note on a delivered row, and null when the adapter returns nothing', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
      values ('ann_w', 1, 'publish', 'webhook', 'sub_2')`;
    const adapter: ChannelAdapter = {
      channel: 'webhook',
      deliver: async (_a, target) => {
        if (target === 'sub_1') return { publishNote: 'failed: crosspost HTTP 403' };
        return undefined;
      },
    };
    await runFanoutOnce(sql, { webhook: adapter });
    const rows = await sql`select target, status, publish_note from delivery_ledger order by target`;
    expect(rows.map(r => [r.target, r.status, r.publish_note])).toEqual([
      ['sub_1', 'delivered', 'failed: crosspost HTTP 403'],
      ['sub_2', 'delivered', null],
    ]);
  });

  it('a non-string publish note does not throw and does not turn a delivered row into a retry', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
      values ('ann_w', 1, 'publish', 'webhook', 'sub_2')`;
    const adapter: ChannelAdapter = {
      channel: 'webhook',
      deliver: async (_a, target) => {
        if (target === 'sub_1') return { publishNote: 403 } as unknown as { publishNote: string };
        return { publishNote: 'x'.repeat(500) };
      },
    };
    await runFanoutOnce(sql, { webhook: adapter });
    const [bySub1, bySub2] = await sql`select target, status, attempts, last_error, publish_note from delivery_ledger order by target`;
    expect(bySub1.status).toBe('delivered');
    expect(bySub1.attempts).toBe(1);
    expect(bySub1.last_error).toBeNull();
    expect(bySub1.publish_note).toBeNull();
    expect(bySub2.status).toBe('delivered');
    expect(bySub2.attempts).toBe(1);
    expect(bySub2.last_error).toBeNull();
    expect(bySub2.publish_note.length).toBe(200);
  });

  it('delivers and records without the publish_note column when migration 020 has not been applied yet', async () => {
    // A dedicated, non-prepared connection: postgres.js caches a prepared
    // plan for `select *` on the shared `sql` fixture, and that cached plan
    // survives the `alter table` below within the same session — this
    // connection is opened fresh, after the drop, so every query on it sees
    // the real (column-less) shape, the way a freshly-deployed worker would.
    await sql`alter table delivery_ledger drop column publish_note`;
    const noPrepSql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      let calls = 0;
      const adapter: ChannelAdapter = {
        channel: 'webhook',
        deliver: async () => { calls++; return { publishNote: 'published' }; },
      };
      const res = await runFanoutOnce(noPrepSql, { webhook: adapter });
      expect(res).toEqual({ delivered: 1, failed: 0 });
      const [row] = await noPrepSql`select status, attempts from delivery_ledger where target = 'sub_1'`;
      expect(row.status).toBe('delivered');
      expect(row.attempts).toBe(1);

      // A second pass must not re-deliver: the row is already 'delivered'.
      const res2 = await runFanoutOnce(noPrepSql, { webhook: adapter });
      expect(res2).toEqual({ delivered: 0, failed: 0 });
      expect(calls).toBe(1);
    } finally {
      await noPrepSql.end();
      await sql`alter table delivery_ledger add column publish_note text`;
    }
  });

  it('delivers a second row for another channel in the same batch, also once, without the publish_note column', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
      values ('ann_w', 1, 'publish', 'telegram', 'sub_2')`;
    await sql`alter table delivery_ledger drop column publish_note`;
    const noPrepSql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      const calls: string[] = [];
      const webhook: ChannelAdapter = {
        channel: 'webhook',
        deliver: async (_a, target) => { calls.push(`webhook:${target}`); return { publishNote: 'published' }; },
      };
      const telegram: ChannelAdapter = {
        channel: 'telegram',
        deliver: async (_a, target) => { calls.push(`telegram:${target}`); },
      };
      const res = await runFanoutOnce(noPrepSql, { webhook, telegram });
      expect(res).toEqual({ delivered: 2, failed: 0 });
      expect(calls.sort()).toEqual(['telegram:sub_2', 'webhook:sub_1']);
      const rows = await noPrepSql`select target, status from delivery_ledger order by target`;
      expect(rows.every(r => r.status === 'delivered')).toBe(true);
    } finally {
      await noPrepSql.end();
      await sql`alter table delivery_ledger add column publish_note text`;
    }
  });

  it('an orphaned ledger row (announcement deleted) is marked exhausted and does not block the batch', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, next_attempt_at)
      values ('ann_missing', 1, 'publish', 'webhook', 'sub_orphan', now() - interval '2 days')`;
    const calls: string[] = [];
    const res = await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    expect(res).toEqual({ delivered: 1, failed: 0 });
    expect(calls).toEqual(['ann_w:sub_1']);
    const [orphan] = await sql`select status, last_error, next_attempt_at > now() - interval '1 minute' as stamped from delivery_ledger where target = 'sub_orphan'`;
    expect(orphan.status).toBe('exhausted');
    expect(orphan.last_error).toBe('announcement missing');
    expect(orphan.stamped).toBe(true); // health.ts's exhausted window needs a fresh timestamp
    const [good] = await sql`select status from delivery_ledger where target = 'sub_1'`;
    expect(good.status).toBe('delivered');
  });
});
