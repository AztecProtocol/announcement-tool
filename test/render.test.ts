import { describe, it, expect } from 'vitest';
import { canonicalUrl, tagLine, kindPrefix, renderPlain, renderMarkdown, renderEmail, renderTelegramHtml, stripMarkdown, renderBodyHtml, formatDeadline, headingToBold } from '../src/core/render.js';
import type { Announcement } from '../src/core/types.js';

const baseAnnouncement: Announcement = {
  id: 'ann_R', revision: 1, slug: '2026-08-upgrade-v5-1-0', type: 'upgrade',
  networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.1.0 by 2026-08-20 14:00 UTC',
  bodyMd: 'Sequencers must upgrade.\n\nSee the release notes.',
  actionsRequired: [{ action: 'Upgrade node to v5.1.0', deadline: '2026-08-20T14:00:00Z', applies_to: ['sequencer', 'prover'] }],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
  status: 'published', createdBy: 'a@x', publishedAt: '2026-08-06T10:00:00Z',
};

const a = baseAnnouncement;

describe('render', () => {
  it('builds the canonical url from PUBLIC_BASE_URL', () => {
    expect(canonicalUrl(a)).toBe('https://announce.aztec.network/a/2026-08-upgrade-v5-1-0');
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
    expect(out).toContain('20 Aug 2026, 14:00 UTC'); // humanized, not raw ISO
    expect(out).toContain('sequencer, prover');
    expect(out).toContain('https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0');
    expect(out.trimEnd().endsWith('https://announce.aztec.network/a/2026-08-upgrade-v5-1-0')).toBe(true);
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

describe('renderEmail html part', () => {
  it('returns an HTML body with bold title, converted markdown, and the unsubscribe placeholder', () => {
    const { html } = renderEmail({ ...a, bodyMd: 'A **bold** word and 1 < 2.' }, 'publish');
    expect(html).toContain('<h1');
    expect(html).toContain('Upgrade to v5.1.0 by 2026-08-20 14:00 UTC');
    expect(html).toContain('A <b>bold</b> word and 1 &lt; 2.');
    expect(html).toContain('{{UNSUBSCRIBE}}');
    expect(html).toContain('/a/2026-08-upgrade-v5-1-0');
  });

  it('lists actions with an escaped deadline and audience', () => {
    const { html } = renderEmail(a, 'publish');
    expect(html).toContain('<strong>Action required:</strong>');
    expect(html).toContain('Upgrade node to v5.1.0');
    expect(html).toContain('<strong>20 Aug 2026, 14:00 UTC</strong>');
    expect(html).toContain('(sequencer, prover)');
  });
});

describe('renderBodyHtml', () => {
  it('renders markdown paragraphs with escaped entities', () => {
    const html = renderBodyHtml('One **bold**.\n\nTwo < three.');
    expect(html).toBe('<p style="margin:0 0 12px">One <b>bold</b>.</p>\n<p style="margin:0 0 12px">Two &lt; three.</p>');
  });
});

describe('formatDeadline', () => {
  it('renders an unambiguous UTC timestamp for human channels', () => {
    expect(formatDeadline('2026-08-24T10:56:26Z')).toBe('24 Aug 2026, 10:56 UTC');
    expect(formatDeadline('2026-01-05T09:05:00.000Z')).toBe('5 Jan 2026, 09:05 UTC');
  });

  it('converts a non-UTC offset to UTC rather than showing local time', () => {
    expect(formatDeadline('2026-08-24T12:56:26+02:00')).toBe('24 Aug 2026, 10:56 UTC');
  });

  it('returns unparseable input unchanged instead of printing Invalid Date', () => {
    expect(formatDeadline('not a date')).toBe('not a date');
  });

  it('humanizes deadlines in every human-facing rendering', () => {
    const withDeadline = {
      ...a,
      actionsRequired: [{ action: 'Upgrade', deadline: '2026-08-24T10:56:26Z', applies_to: ['sequencer'] }],
    };
    for (const out of [
      renderPlain(withDeadline, 'publish'),
      renderMarkdown(withDeadline, 'publish'),
      renderTelegramHtml(withDeadline, 'publish'),
      renderEmail(withDeadline, 'publish').text,
      renderEmail(withDeadline, 'publish').html,
    ]) {
      expect(out).toContain('24 Aug 2026, 10:56 UTC');
      expect(out).not.toContain('2026-08-24T10:56:26Z');
    }
  });
});

describe('headings', () => {
  const body = 'Intro line.\n\n## What changes\n\nDetail line.\n\n### Smaller\n\nMore.';

  it('uppercases headings and drops markers in plain text', () => {
    const out = stripMarkdown(body);
    expect(out).toContain('WHAT CHANGES');
    expect(out).toContain('SMALLER');
    expect(out).not.toContain('##');
  });

  it('leaves a hash that is not a heading alone', () => {
    expect(stripMarkdown('issue #123 and C# code')).toBe('issue #123 and C# code');
  });

  it('does not uppercase a hash inside a line', () => {
    expect(stripMarkdown('see ## not a heading')).toBe('see ## not a heading');
  });

  it('converts headings to bold for telegram', () => {
    expect(headingToBold('## What changes')).toBe('<b>What changes</b>');
    expect(headingToBold('### Smaller')).toBe('<b>Smaller</b>');
  });

  it('renders headings as h2/h3 in email html', () => {
    const html = renderBodyHtml(body);
    expect(html).toMatch(/<h2[^>]*>What changes<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>Smaller<\/h3>/);
    expect(html).not.toContain('## What changes');
  });

  it('escapes html inside a heading', () => {
    expect(renderBodyHtml('## a <b> & c')).toContain('a &lt;b&gt; &amp; c');
    expect(headingToBold('## a <b>')).toBe('<b>a &lt;b&gt;</b>');
  });

  it('keeps telegram headings bold end to end', () => {
    const ann = { ...baseAnnouncement, bodyMd: '## What changes\n\nDetail.' };
    const out = renderTelegramHtml(ann, 'publish');
    expect(out).toContain('<b>What changes</b>');
    expect(out).not.toContain('## What changes');
  });

  it('leaves discord markdown headings untouched', () => {
    const ann = { ...baseAnnouncement, bodyMd: '## What changes' };
    expect(renderMarkdown(ann, 'publish')).toContain('## What changes');
  });

  it('does not emit an h1 for a single-hash line', () => {
    expect(renderBodyHtml('# Top')).not.toContain('<h1');
  });

  it('leaves a single-hash line as literal text', () => {
    expect(stripMarkdown('# Top')).toBe('# Top');
  });
});
