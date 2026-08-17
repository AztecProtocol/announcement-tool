import { describe, it, expect } from 'vitest';
import { normalizeNewlines } from '../src/core/text.js';
import {
  stripMarkdown, renderBodyHtml, renderTelegramHtml, renderPlain, renderMarkdown,
} from '../src/core/render.js';
import { parseMarkdownBlocks } from '../app/admin/preview-render.js';
import type { Announcement } from '../src/core/types.js';

/** A body exactly as a browser submits it: every newline is CRLF. */
const CRLF_BODY = 'Intro line.\r\n\r\n## What changes\r\n\r\nDetail line.';

const announcement = (bodyMd: string): Announcement => ({
  id: 'ann_crlf', revision: 1, slug: 'crlf-test', type: 'upgrade',
  networks: ['testnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.2.0', bodyMd, actionsRequired: [], links: [],
  status: 'published', createdBy: 'test', publishedAt: '2026-08-17T10:00:00Z',
});

describe('normalizeNewlines', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeNewlines('a\r\nb')).toBe('a\nb');
  });

  it('converts a lone CR to LF', () => {
    expect(normalizeNewlines('a\rb')).toBe('a\nb');
  });

  it('leaves LF untouched', () => {
    expect(normalizeNewlines('a\nb')).toBe('a\nb');
  });

  it('trims surrounding whitespace like the plain field reader does', () => {
    expect(normalizeNewlines('  a\r\nb  ')).toBe('a\nb');
  });

  it('preserves blank lines between paragraphs', () => {
    expect(normalizeNewlines('a\r\n\r\nb')).toBe('a\n\nb');
  });
});

// These four assertions are the regression guard for the bug found during the
// 2026-08-17 admin walkthrough: a CRLF body silently defeated heading detection
// on every channel, and collapsed the email HTML into a single paragraph.
describe('a CRLF body renders correctly once normalised', () => {
  const body = normalizeNewlines(CRLF_BODY);

  it('uppercases the heading for signal and the email text part', () => {
    expect(stripMarkdown(body)).toContain('WHAT CHANGES');
    expect(stripMarkdown(body)).not.toContain('##');
  });

  it('emits a real heading element in the email html part', () => {
    const html = renderBodyHtml(body);
    expect(html).toMatch(/<h2[^>]*>What changes<\/h2>/);
    expect(html).not.toContain('## What changes');
  });

  it('splits the email html into separate paragraphs', () => {
    // The original defect: \r\n\r\n never matched the /\n{2,}/ paragraph split,
    // so the whole body became one <p> joined by <br> tags.
    const paragraphs = renderBodyHtml(body).match(/<p /g) ?? [];
    expect(paragraphs.length).toBeGreaterThan(1);
  });

  it('bolds the heading for telegram', () => {
    const out = renderTelegramHtml(announcement(body), 'publish');
    expect(out).toContain('<b>What changes</b>');
    expect(out).not.toContain('## What changes');
  });
});

describe('an un-normalised CRLF body still fails, proving the guard is load-bearing', () => {
  // If someone removes normalizeNewlines from inputFromForm, these are the
  // symptoms that return. Asserting them here documents why the call exists.
  it('leaves the heading literal on plain-text channels', () => {
    expect(stripMarkdown(CRLF_BODY)).toContain('## What changes');
  });

  it('does not split the email html into paragraphs', () => {
    const paragraphs = renderBodyHtml(CRLF_BODY).match(/<p /g) ?? [];
    expect(paragraphs).toHaveLength(1);
  });
});

describe('the preview parser agrees once the body is normalised', () => {
  it('reads the heading as a heading block', () => {
    const md = renderMarkdown(announcement(normalizeNewlines(CRLF_BODY)), 'publish');
    expect(parseMarkdownBlocks(md).some(b => b.kind === 'heading')).toBe(true);
  });

  it('does not read a heading from the un-normalised body', () => {
    const md = renderMarkdown(announcement(CRLF_BODY), 'publish');
    expect(parseMarkdownBlocks(md).some(b => b.kind === 'heading')).toBe(false);
  });
});

describe('signal rendering of a normalised body', () => {
  it('carries no markdown markers', () => {
    const out = renderPlain(announcement(normalizeNewlines(CRLF_BODY)), 'publish');
    expect(out).toContain('WHAT CHANGES');
    expect(out).not.toContain('##');
  });
});
