import { describe, it, expect } from 'vitest';
import { canonicalUrl, tagLine, kindPrefix, renderPlain, renderMarkdown, renderEmail, renderTelegramHtml, stripMarkdown } from '../src/core/render.js';
import type { Announcement } from '../src/core/types.js';

const a: Announcement = {
  id: 'ann_R', revision: 1, slug: '2026-08-upgrade-v5-1-0', type: 'upgrade',
  networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.1.0 by 2026-08-20 14:00 UTC',
  bodyMd: 'Sequencers must upgrade.\n\nSee the release notes.',
  actionsRequired: [{ action: 'Upgrade node to v5.1.0', deadline: '2026-08-20T14:00:00Z', applies_to: ['sequencer', 'prover'] }],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
  status: 'published', createdBy: 'a@x', publishedAt: '2026-08-06T10:00:00Z',
};

describe('render', () => {
  it('builds the canonical url from PUBLIC_BASE_URL', () => {
    expect(canonicalUrl(a)).toBe('https://announce.aztec.foundation/a/2026-08-upgrade-v5-1-0');
  });

  it('tags networks, severity and type in order', () => {
    expect(tagLine(a)).toBe('[MAINNET] [CRITICAL] [UPGRADE]');
    expect(tagLine({ ...a, networks: ['testnet', 'mainnet'], severity: 'info', type: 'governance' }))
      .toBe('[MAINNET] [TESTNET] [INFO] [GOVERNANCE]');
  });

  it('prefixes update and reminder kinds only', () => {
    expect(kindPrefix('publish')).toBe('');
    expect(kindPrefix('update')).toBe('UPDATED: ');
    expect(kindPrefix('reminder')).toBe('REMINDER: ');
  });

  it('plain text carries tags, title, actions with deadline, links and canonical url', () => {
    const out = renderPlain(a, 'publish');
    expect(out).toContain('[MAINNET] [CRITICAL] [UPGRADE]');
    expect(out).toContain('Upgrade to v5.1.0 by 2026-08-20 14:00 UTC');
    expect(out).toContain('Upgrade node to v5.1.0');
    expect(out).toContain('2026-08-20T14:00:00Z');
    expect(out).toContain('sequencer, prover');
    expect(out).toContain('https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0');
    expect(out.trimEnd().endsWith('https://announce.aztec.foundation/a/2026-08-upgrade-v5-1-0')).toBe(true);
  });

  it('markdown bolds the title and bullets the actions', () => {
    const out = renderMarkdown(a, 'publish');
    expect(out).toContain('**Upgrade to v5.1.0 by 2026-08-20 14:00 UTC**');
    expect(out).toContain('- Upgrade node to v5.1.0');
  });

  it('reminder kind shows in both subject and body', () => {
    const { subject, text } = renderEmail(a, 'reminder');
    expect(subject).toBe('REMINDER: [MAINNET] [CRITICAL] [UPGRADE] Upgrade to v5.1.0 by 2026-08-20 14:00 UTC');
    expect(text).toContain('REMINDER:');
    expect(text).toContain('{{UNSUBSCRIBE}}');
  });

  it('omits the actions section when there are none', () => {
    const out = renderPlain({ ...a, actionsRequired: [] }, 'publish');
    expect(out).not.toContain('Action required');
  });
});

describe('markdown handling per channel', () => {
  const md = { ...a, bodyMd: 'A **bold** word, `code`, a [link](https://example.com/x), and 1 < 2 & 3 > 2.' };

  it('renderPlain strips markdown markers so no literal ** reaches a reader', () => {
    const out = renderPlain(md, 'publish');
    expect(out).toContain('A bold word, code, a link: https://example.com/x, and 1 < 2 & 3 > 2.');
    expect(out).not.toContain('**');
  });

  it('renderTelegramHtml converts to balanced HTML with entities escaped', () => {
    const out = renderTelegramHtml(md, 'publish');
    expect(out).toContain('<b>Upgrade to v5.1.0 by 2026-08-20 14:00 UTC</b>');
    expect(out).toContain('A <b>bold</b> word, <code>code</code>, a <a href="https://example.com/x">link</a>');
    expect(out).toContain('1 &lt; 2 &amp; 3 &gt; 2');
    expect(out).not.toContain('**');
  });

  it('unmatched ** stays literal instead of producing a broken tag', () => {
    const out = renderTelegramHtml({ ...a, bodyMd: 'an unmatched ** marker' }, 'publish');
    expect(out).toContain('an unmatched ** marker');
    expect(out).not.toContain('<b></b>');
  });

  it('stripMarkdown turns inline links into "label: url"', () => {
    expect(stripMarkdown('see [the docs](https://docs.example.com) now'))
      .toBe('see the docs: https://docs.example.com now');
  });
});
