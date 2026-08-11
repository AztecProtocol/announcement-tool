import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { createDraft, reviseDraft, getLatest } from '../src/core/announcements.js';
import type { AnnouncementInput } from '../src/core/types.js';
import { renderPlain, renderMarkdown } from '../src/core/render.js';
import { makeSlug } from '../src/core/ids.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

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

describe('jsonb columns store real arrays, not double-encoded strings', () => {
  const inputWithData: AnnouncementInput = {
    type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
    title: 'Upgrade to v5.1.0', bodyMd: 'Do it.',
    actionsRequired: [{ action: 'Update your node', deadline: '2026-09-01T00:00:00Z', applies_to: ['sequencers'] }],
    links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
  };

  it('round-trips actionsRequired and links as real jsonb arrays', async () => {
    const created = await createDraft(sql, inputWithData, 'yev@aztec.foundation');
    const a = await getLatest(sql, created.id);
    expect(a).toBeDefined();

    expect(Array.isArray(a!.actionsRequired)).toBe(true);
    expect(Array.isArray(a!.links)).toBe(true);
    expect(a!.actionsRequired[0].action).toBe('Update your node');
    expect(a!.links[0].url).toBe('https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0');

    const [typeCheck] = await sql`
      select jsonb_typeof(actions_required) as ar_type, jsonb_typeof(links) as links_type
      from announcements where id = ${created.id} order by revision desc limit 1`;
    expect(typeCheck.ar_type).toBe('array');
    expect(typeCheck.links_type).toBe('array');
  });

  it('renders an announcement read back from the database without throwing', async () => {
    const created = await createDraft(sql, inputWithData, 'yev@aztec.foundation');
    const a = await getLatest(sql, created.id);
    expect(a).toBeDefined();

    expect(() => renderPlain(a!, 'publish')).not.toThrow();
    expect(() => renderMarkdown(a!, 'publish')).not.toThrow();

    const plain = renderPlain(a!, 'publish');
    const md = renderMarkdown(a!, 'publish');
    expect(plain).toContain('Update your node');
    expect(md).toContain('Update your node');
  });

  it('stores audit_log detail as real jsonb, not a string', async () => {
    const created = await createDraft(sql, inputWithData, 'yev@aztec.foundation');
    const [row] = await sql`
      select jsonb_typeof(detail) as detail_type from audit_log where target = ${created.id} limit 1`;
    expect(row.detail_type).toBe('object');
  });

  it('same-title drafts in the same month get distinct slugs', async () => {
    const a = await createDraft(sql, input, 'yev@aztec.foundation');
    const b = await createDraft(sql, input, 'yev@aztec.foundation');
    const c = await createDraft(sql, input, 'yev@aztec.foundation');
    expect(b.slug).toBe(`${a.slug}-2`);
    expect(c.slug).toBe(`${a.slug}-3`);
  });

  it('gives up loudly once all 20 slug candidates are taken', async () => {
    const base = makeSlug(new Date(), input.type, input.title);
    const candidates = [base, ...Array.from({ length: 19 }, (_, i) => `${base}-${i + 2}`)];
    for (const [i, slug] of candidates.entries()) {
      await sql`insert into announcements
        (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by)
        values (${`ann_seed_${i}`}, 1, ${slug}, ${input.type}, ${input.networks}, ${input.audiences},
                ${input.severity}, ${input.title}, ${input.bodyMd}, 'draft', 'a@x')`;
    }
    await expect(createDraft(sql, input, 'yev@aztec.foundation')).rejects.toThrow(/free slug/);
  });
});
