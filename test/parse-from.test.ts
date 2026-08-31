import { describe, it, expect } from 'vitest';
import { parseFrom, editPrefillFromAnnouncement } from '../app/admin/parse-from.js';
import type { Announcement } from '../src/core/types.js';

describe('parseFrom', () => {
  it('parses an edit: reference into kind + id', () => {
    expect(parseFrom('edit:abc')).toEqual({ kind: 'edit', id: 'abc' });
  });

  it('parses template: and announcement: references, unchanged from before', () => {
    expect(parseFrom('template:t1')).toEqual({ kind: 'template', id: 't1' });
    expect(parseFrom('announcement:a1')).toEqual({ kind: 'announcement', id: 'a1' });
  });

  it('returns undefined for a kind with no id', () => {
    expect(parseFrom('edit:')).toBeUndefined();
  });

  it('returns undefined for an unrecognised kind', () => {
    expect(parseFrom('bogus:abc')).toBeUndefined();
  });

  it('returns undefined when from is undefined', () => {
    expect(parseFrom(undefined)).toBeUndefined();
  });

  it('keeps a colon embedded in the id, via rest.join(":")', () => {
    expect(parseFrom('edit:abc:def')).toEqual({ kind: 'edit', id: 'abc:def' });
  });
});

const announcement = (overrides: Partial<Announcement> = {}): Announcement => ({
  id: 'ann-1',
  revision: 2,
  slug: 'fixed-slug-2026',
  type: 'upgrade',
  networks: ['mainnet'],
  audiences: ['operators'],
  severity: 'critical',
  title: 'Upgrade to v5.2',
  bodyMd: 'Body.',
  actionsRequired: [{ action: 'Update your node', deadline: '2026-09-01T00:00:00.000Z', applies_to: ['sequencer'] }],
  links: [{ label: 'Release', url: 'https://example.test/release' }],
  status: 'draft',
  createdBy: 'alice@test.local',
  mentionRoleIds: ['role-1', 'role-2'],
  ...overrides,
});

describe('editPrefillFromAnnouncement', () => {
  // Regression guard: someone later "simplifying" the edit branch in page.tsx
  // into a templateFromAnnouncement call would silently strip these two
  // fields, breaking edit mode.
  it('retains the slug — unlike templateFromAnnouncement, which strips it for the copy-into-new-draft path', () => {
    const out = editPrefillFromAnnouncement(announcement());
    expect(out.slug).toBe('fixed-slug-2026');
  });

  it("retains each action's deadline — unlike templateFromAnnouncement, which clears it", () => {
    const out = editPrefillFromAnnouncement(announcement());
    expect(out.actionsRequired[0].deadline).toBe('2026-09-01T00:00:00.000Z');
  });

  it('retains mentionRoleIds, so the compose form can seed the same selection the announcement was rejected or saved with', () => {
    const out = editPrefillFromAnnouncement(announcement());
    expect(out.mentionRoleIds).toEqual(['role-1', 'role-2']);
  });

  it('carries an empty mentionRoleIds through as undefined, matching the "no roles selected" case', () => {
    const out = editPrefillFromAnnouncement(announcement({ mentionRoleIds: undefined }));
    expect(out.mentionRoleIds).toBeUndefined();
  });
});
