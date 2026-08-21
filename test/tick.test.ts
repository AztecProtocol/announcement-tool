import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { runTick } from '../src/worker/tick.js';
import type { ChannelAdapter } from '../src/adapters/types.js';
import { makeConsoleSender } from '../src/adapters/esp.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const sender = makeConsoleSender();

const okAdapter = (calls: string[]): ChannelAdapter => ({
  channel: 'webhook',
  deliver: async (a, target) => { calls.push(`${a.id}:${target}`); },
});

describe('runTick', () => {
  it('publishes a due scheduled announcement and reports it', async () => {
    await sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by, scheduled_for)
      values ('ann_s', 1, 's', 'upgrade', '{mainnet}', '{operators}', 'info', 't', 'b', 'scheduled', 'a@x', now() - interval '1 minute')`;
    const result = await runTick(sql, {}, sender);
    expect(result.published).toHaveLength(1);
    expect(result.published).toEqual(['ann_s']);
  });

  it('still runs fan-out when the scheduler throws', async () => {
    // publishDueScheduled runs inside sql.begin(...) as the tick's very first
    // transactional call; runFanoutOnce and dispatchHealthAlerts each start
    // their own sql.begin(...) later. Wrapping .begin so only the FIRST call
    // throws forces the scheduler section to fail from outside runTick,
    // without touching any production code — runTick only requires a `Sql`,
    // and this is a spy over the real connection pool's `.begin` method.
    let beginCalls = 0;
    const realBegin = sql.begin.bind(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sql as any).begin = (...args: unknown[]) => {
      beginCalls++;
      if (beginCalls === 1) throw new Error('scheduler transaction unavailable');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realBegin as any)(...args);
    };
    try {
      await sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by)
        values ('ann_w', 1, 's', 'upgrade', '{mainnet}', '{operators}', 'critical', 't', 'b', 'published', 'a@x')`;
      await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
        values ('ann_w', 1, 'publish', 'webhook', 'sub_1')`;

      const calls: string[] = [];
      const result = await runTick(sql, { webhook: okAdapter(calls) }, sender);

      // The error-isolation property: a scheduler failure must not prevent
      // fan-out (or health alerting) from running on the same tick.
      expect(result.delivered).toBe(1);
      expect(result.failed).toBe(0);
      expect(calls).toEqual(['ann_w:sub_1']);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sql as any).begin = realBegin;
    }
  });

  it('reports zero counts on an empty database without throwing', async () => {
    const result = await runTick(sql, {}, sender);
    expect(result).toEqual({ published: [], delivered: 0, failed: 0, alerted: 0 });
  });
});
