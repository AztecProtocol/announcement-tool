import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { saveTemplate, listTemplates, getTemplate, deleteTemplate, templateFromAnnouncement, stripPerAnnouncementFields } from '../src/core/templates.js';
import { createDraft } from '../src/core/announcements.js';
import type { AnnouncementInput, Announcement } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const input: AnnouncementInput = {
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.1.0', bodyMd: 'Do it.',
  actionsRequired: [{ action: 'Update your node', deadline: '2026-09-01T00:00:00Z', applies_to: ['sequencers'] }],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
};

describe('stripPerAnnouncementFields: the safety property', () => {
  it('drops a slug carried on the input', () => {
    const withSlug: AnnouncementInput = { ...input, slug: 'a-specific-announcements-slug' };
    const out = stripPerAnnouncementFields(withSlug);
    expect(out.slug).toBeUndefined();
  });

  it('drops mentionRoles carried on the input', () => {
    const withMention: AnnouncementInput = { ...input, mentionRoles: true };
    const out = stripPerAnnouncementFields(withMention);
    expect(out.mentionRoles).toBeUndefined();
  });

  it('keeps every other field untouched', () => {
    const withSlug: AnnouncementInput = { ...input, slug: 'a-specific-announcements-slug', mentionRoles: true };
    const out = stripPerAnnouncementFields(withSlug);
    expect(out.title).toBe(input.title);
    expect(out.bodyMd).toBe(input.bodyMd);
    expect(out.actionsRequired).toEqual(input.actionsRequired);
    expect(out.links).toEqual(input.links);
  });

  it('is a no-op when the input has no slug or mentionRoles', () => {
    const out = stripPerAnnouncementFields(input);
    expect(out.slug).toBeUndefined();
    expect(out.mentionRoles).toBeUndefined();
  });
});

describe('templates: save/list/get roundtrip', () => {
  it('a saved template stores no slug or mentionRoles even when the compose form input carried them', async () => {
    const withSlug: AnnouncementInput = { ...input, slug: 'a-specific-announcements-slug', mentionRoles: true };
    const t = await saveTemplate(sql, { name: 'No slug leak', input: stripPerAnnouncementFields(withSlug), createdBy: 'yev@aztec.foundation' });
    expect(t.input.slug).toBeUndefined();
    expect(t.input.mentionRoles).toBeUndefined();
    const got = await getTemplate(sql, t.id);
    expect(got!.input.slug).toBeUndefined();
    expect(got!.input.mentionRoles).toBeUndefined();
  });

  it('saves, lists, and gets a template', async () => {
    const t = await saveTemplate(sql, { name: 'Upgrade boilerplate', input, createdBy: 'yev@aztec.foundation' });
    expect(t.name).toBe('Upgrade boilerplate');
    expect(t.input.title).toBe('Upgrade to v5.1.0');

    const list = await listTemplates(sql);
    expect(list.map(x => x.id)).toContain(t.id);

    const got = await getTemplate(sql, t.id);
    expect(got).toBeDefined();
    expect(got!.name).toBe('Upgrade boilerplate');
    expect(got!.input.actionsRequired[0].action).toBe('Update your node');
    expect(got!.input.links[0].url).toBe(input.links[0].url);
    expect(Array.isArray(got!.input.actionsRequired)).toBe(true);
    expect(Array.isArray(got!.input.links)).toBe(true);
  });

  it('upserts on duplicate name — replaces rather than erroring', async () => {
    const first = await saveTemplate(sql, { name: 'Same name', input, createdBy: 'yev@aztec.foundation' });
    const second = await saveTemplate(
      sql,
      { name: 'Same name', input: { ...input, title: 'Upgrade to v5.2.0' }, createdBy: 'yev@aztec.foundation' },
    );
    expect(second.name).toBe('Same name');
    expect(second.input.title).toBe('Upgrade to v5.2.0');

    const list = await listTemplates(sql);
    const matching = list.filter(t => t.name === 'Same name');
    expect(matching.length).toBe(1);

    const got = await getTemplate(sql, second.id);
    expect(got!.input.title).toBe('Upgrade to v5.2.0');
    // first id may or may not equal second id depending on upsert strategy;
    // what matters is there's exactly one row for this name with the latest input.
    void first;
  });

  it('deleteTemplate returns false for an unknown id, true for a known one', async () => {
    expect(await deleteTemplate(sql, 'tpl_does_not_exist')).toBe(false);
    const t = await saveTemplate(sql, { name: 'To delete', input, createdBy: 'yev@aztec.foundation' });
    expect(await deleteTemplate(sql, t.id)).toBe(true);
    expect(await getTemplate(sql, t.id)).toBeUndefined();
  });
});

describe('templateFromAnnouncement: the safety property', () => {
  it('clears every action deadline while keeping everything else', async () => {
    const created = await createDraft(sql, input, 'yev@aztec.foundation');
    const a = created as Announcement;

    const out = templateFromAnnouncement(a);

    expect(out.actionsRequired.length).toBeGreaterThan(0);
    for (const ar of out.actionsRequired) {
      expect(ar.deadline).toBeUndefined();
    }

    // Everything else survives.
    expect(out.type).toBe(a.type);
    expect(out.networks).toEqual(a.networks);
    expect(out.audiences).toEqual(a.audiences);
    expect(out.severity).toBe(a.severity);
    expect(out.title).toBe(a.title);
    expect(out.bodyMd).toBe(a.bodyMd);
    expect(out.actionsRequired.map(ar => ar.action)).toEqual(a.actionsRequired.map(ar => ar.action));
    expect(out.actionsRequired.map(ar => ar.applies_to)).toEqual(a.actionsRequired.map(ar => ar.applies_to));
    expect(out.links).toEqual(a.links);
  });

  it('clears deadline on every action when there are multiple', () => {
    const a: Announcement = {
      id: 'ann_x', revision: 1, slug: 's', status: 'draft', createdBy: 'yev@aztec.foundation',
      type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
      title: 'T', bodyMd: 'B',
      actionsRequired: [
        { action: 'A1', deadline: '2026-01-01T00:00:00Z', applies_to: ['sequencers'] },
        { action: 'A2', deadline: '2026-02-01T00:00:00Z', applies_to: ['provers'] },
        { action: 'A3', applies_to: [] },
      ],
      links: [],
    };
    const out = templateFromAnnouncement(a);
    expect(out.actionsRequired.every(ar => ar.deadline === undefined)).toBe(true);
    expect(out.actionsRequired.map(ar => ar.action)).toEqual(['A1', 'A2', 'A3']);
  });

  it('does not mutate the source announcement', () => {
    const a: Announcement = {
      id: 'ann_y', revision: 1, slug: 's', status: 'draft', createdBy: 'yev@aztec.foundation',
      type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
      title: 'T', bodyMd: 'B',
      actionsRequired: [{ action: 'A1', deadline: '2026-01-01T00:00:00Z', applies_to: ['sequencers'] }],
      links: [],
    };
    templateFromAnnouncement(a);
    expect(a.actionsRequired[0].deadline).toBe('2026-01-01T00:00:00Z');
  });
});
