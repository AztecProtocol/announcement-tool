import { describe, it, expect } from 'vitest';
import { newAnnouncementId, newSubscriptionId, newSecret, makeSlug } from '../src/core/ids.js';
import { validateAnnouncement } from '../src/core/validate.js';
import type { AnnouncementInput } from '../src/core/types.js';

const base: AnnouncementInput = {
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.1.0 required by 2026-08-20 14:00 UTC', bodyMd: 'Body.',
  actionsRequired: [{ action: 'Upgrade node to v5.1.0', deadline: '2026-08-20T14:00:00Z', applies_to: ['sequencer'] }],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
};

describe('ids', () => {
  it('generates prefixed ids and secrets', () => {
    expect(newAnnouncementId()).toMatch(/^ann_[0-9A-Z]{26}$/);
    expect(newSubscriptionId()).toMatch(/^sub_[0-9A-Z]{26}$/);
    expect(newSecret()).toMatch(/^whsec_[0-9a-f]{48}$/);
  });
  it('makes url-safe slugs: yyyy-mm-type-first-words', () => {
    const s = makeSlug(new Date('2026-08-06T10:00:00Z'), 'upgrade', 'Upgrade to v5.1.0 required by 2026-08-20 14:00 UTC');
    expect(s).toBe('2026-08-upgrade-upgrade-to-v5-1-0-required-by');
  });
});

describe('validateAnnouncement', () => {
  it('accepts a valid input with no warnings', () => {
    expect(validateAnnouncement(base).warnings).toEqual([]);
  });
  it('rejects out-of-enum values', () => {
    expect(() => validateAnnouncement({ ...base, type: 'marketing' as never })).toThrow();
    expect(() => validateAnnouncement({ ...base, networks: [] })).toThrow(); // at least one network
  });
  it('warns when an upgrade announcement has no GitHub release link', () => {
    const { warnings } = validateAnnouncement({ ...base, links: [] });
    expect(warnings.some(w => w.includes('GitHub release'))).toBe(true);
  });
  it('rejects link schemes other than http/https', () => {
    expect(() => validateAnnouncement({ ...base, links: [{ label: 'x', url: 'javascript:alert(1)' }] })).toThrow();
    expect(() => validateAnnouncement({ ...base, links: [{ label: 'x', url: 'data:text/html,<script>' }] })).toThrow();
    expect(() => validateAnnouncement({ ...base, links: [{ label: 'ok', url: 'http://example.com/x' }] })).not.toThrow();
  });
});
