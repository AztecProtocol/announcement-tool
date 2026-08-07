import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

describe('schema', () => {
  it('rejects duplicate delivery rows (dedupe constraint)', async () => {
    await sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by)
      values ('ann_x', 1, 's', 'upgrade', '{mainnet}', '{operators}', 'critical', 't', 'b', 'published', 'a@x')`;
    const row = () => sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
      values ('ann_x', 1, 'publish', 'webhook', 'sub_1')`;
    await row();
    await expect(row()).rejects.toThrow(/duplicate key/);
  });

  it('rejects out-of-enum type and severity', async () => {
    const bad = sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by)
      values ('ann_y', 1, 's2', 'marketing', '{mainnet}', '{operators}', 'critical', 't', 'b', 'draft', 'a@x')`;
    await expect(bad).rejects.toThrow(/check constraint/);
  });

  it('audit_log accepts inserts and has a monotonic seq', async () => {
    await sql`insert into audit_log (actor, action, target) values ('a@x', 'draft_created', 'ann_x')`;
    await sql`insert into audit_log (actor, action, target) values ('a@x', 'edited', 'ann_x')`;
    const rows = await sql`select seq from audit_log order by seq`;
    expect(rows.length).toBe(2);
    expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq));
  });
});
