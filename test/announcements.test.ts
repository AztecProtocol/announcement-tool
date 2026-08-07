import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { createDraft, reviseDraft, getLatest } from '../src/core/announcements.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { /* do not close, shared connection */ });

const input: AnnouncementInput = {
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.1.0', bodyMd: 'Do it.',
  actionsRequired: [], links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
};

describe('announcement lifecycle', () => {
  it('creates a draft at revision 1 with slug and audit row', async () => {
    const a = await createDraft(sql, input, 'yev@aztec.foundation');
    expect(a.revision).toBe(1);
    expect(a.status).toBe('draft');
    expect(a.slug).toMatch(/^\d{4}-\d{2}-upgrade-/);
    const audit = await sql`select * from audit_log where target = ${a.id}`;
    expect(audit.map(r => r.action)).toEqual(['draft_created']);
  });

  it('revise inserts a new immutable revision, keeps slug', async () => {
    const a = await createDraft(sql, input, 'yev@aztec.foundation');
    const b = await reviseDraft(sql, a.id, { ...input, title: 'Upgrade to v5.1.1' }, 'yev@aztec.foundation');
    expect(b.revision).toBe(2);
    expect(b.slug).toBe(a.slug);
    const rows = await sql`select revision, title from announcements where id = ${a.id} order by revision`;
    expect(rows.length).toBe(2);
    expect(rows[0].title).toBe('Upgrade to v5.1.0'); // revision 1 untouched
    expect((await getLatest(sql, a.id))!.title).toBe('Upgrade to v5.1.1');
  });

  it('rejects invalid input', async () => {
    await expect(createDraft(sql, { ...input, networks: [] }, 'yev@aztec.foundation')).rejects.toThrow();
  });
});
