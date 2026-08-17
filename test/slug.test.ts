import { describe, it, expect } from 'vitest';
import { makeSlug } from '../src/core/ids.js';
import { normalizeSlug, slugError } from '../src/core/slug.js';

const AUG = new Date('2026-08-17T10:00:00Z');

describe('makeSlug', () => {
  it('does not repeat the type when the title starts with it', () => {
    expect(makeSlug(AUG, 'upgrade', 'Upgrade to v5.2.0 required by 2026-08-28'))
      .toBe('2026-08-upgrade-to-v5-2-0-required');
  });

  it('keeps the type when the title does not start with it', () => {
    expect(makeSlug(AUG, 'governance', 'Signaling window opens Monday'))
      .toBe('2026-08-governance-signaling-window-opens-monday');
  });

  it('is case-insensitive about the repeated type', () => {
    expect(makeSlug(AUG, 'upgrade', 'UPGRADE to v5.2.0')).toBe('2026-08-upgrade-to-v5-2-0');
  });

  it('never ends on a trailing hyphen', () => {
    const s = makeSlug(AUG, 'info', 'A very long announcement title that will certainly be truncated somewhere');
    expect(s.endsWith('-')).toBe(false);
  });

  it('stays within 80 characters', () => {
    const s = makeSlug(AUG, 'info', 'x'.repeat(200));
    expect(s.length).toBeLessThanOrEqual(80);
  });
});

describe('normalizeSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(normalizeSlug('Upgrade To V5.2.0')).toBe('upgrade-to-v5-2-0');
  });

  it('collapses runs of separators', () => {
    expect(normalizeSlug('a -- b__c')).toBe('a-b-c');
  });

  it('strips leading and trailing separators', () => {
    expect(normalizeSlug('--a-b--')).toBe('a-b');
  });
});

describe('slugError', () => {
  it('accepts a normal slug', () => {
    expect(slugError('2026-08-upgrade-to-v5-2-0')).toBeUndefined();
  });

  it('rejects an empty slug', () => {
    expect(slugError('')).toMatch(/empty|required/i);
  });

  it('rejects characters that would be escaped in a URL', () => {
    expect(slugError('a b/c')).toBeTruthy();
  });

  it('rejects a slug longer than 80 characters', () => {
    expect(slugError('a'.repeat(81))).toMatch(/80/);
  });
});
