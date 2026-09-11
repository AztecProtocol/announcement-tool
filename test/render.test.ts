import { describe, it, expect } from 'vitest';
import { canonicalUrl, tagLine, kindPrefix, renderPlain, renderMarkdown, renderEmail, renderTelegramHtml, stripMarkdown, renderBodyHtml, formatDeadline, headingToBold, mdInlineHtml } from '../src/core/render.js';
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

/**
 * Author-supplied text reaches an href attribute in mdInlineHtml,
 * renderTelegramHtml and renderEmail. A quote that survives escaping closes
 * that attribute and turns the rest of the value into an event handler, which
 * the Content-Security-Policy ('unsafe-inline', no script-src) would run.
 */
describe('attribute injection', () => {
  const BREAKOUT = '[x](https://e.com/"onfocus="alert(document.domain)"autofocus=")';
  const SINGLE = "[x](https://e.com/'onclick='alert(1))";
  const LABEL = '[a" onmouseover="alert(1)](https://e.com/)';

  const hostile: Announcement = {
    ...baseAnnouncement,
    bodyMd: BREAKOUT,
    actionsRequired: [],
    links: [{ label: 'x", onmouseover="alert(1)', url: 'https://e.com/" onfocus="alert(1)' }],
  };

  /**
   * Asserting merely that the substring "onfocus" is absent would be wrong in
   * both directions: it fails on a payload correctly neutralised into visible
   * literal text, and it would pass on an attribute spelled with an entity.
   * So parse the emitted tags and check the properties the renderer actually
   * guarantees.
   *
   * Checking only for on*= would pin something weaker than the code provides,
   * and would pass today purely because SAFE_URL_RE independently blocks the
   * rest — so a later loosening of that regex would go uncaught. Hence all
   * four: no event handler (including one separated by "/" rather than
   * whitespace, which HTML accepts), every href is http(s), only the three
   * tags the renderer emits from author content, and no <script> at all.
   *
   * `extraTags` lists tags contributed by a surrounding template (renderEmail
   * and renderBodyHtml wrap content in p/h1/div/...), which are not
   * author-controlled.
   */
  const violations = (html: string, extraTags: string[] = []): string[] => {
    const allowed = new Set(['a', 'b', 'code', ...extraTags]);
    const out: string[] = [];
    if (/<script/i.test(html)) out.push('script tag present');
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      const name = /^<([a-zA-Z0-9]+)/.exec(tag)![1].toLowerCase();
      if (!allowed.has(name)) out.push(`disallowed tag: ${tag}`);
      // whitespace OR "/" before the attribute name: <a href="x"/onfocus="…">
      if (/[\s/]on[a-z]+\s*=/i.test(tag)) out.push(`event handler: ${tag}`);
      for (const [, href] of tag.matchAll(/\shref\s*=\s*"([^"]*)"/gi)) {
        if (!/^https?:\/\//.test(href)) out.push(`non-http href: ${href}`);
      }
    }
    return out;
  };

  it('a quote in the URL cannot close the href attribute', () => {
    const out = mdInlineHtml(BREAKOUT);
    expect(violations(out)).toEqual([]);
    expect((out.match(/<a /g) ?? []).length).toBeLessThanOrEqual(1);
    // the raw quote is gone, so nothing can terminate an attribute value
    expect(out).not.toContain('"onfocus');
    expect(out).toContain('%22onfocus'); // percent-encoded, hence inert
  });

  it('a single quote in the URL cannot open an attribute', () => {
    const out = mdInlineHtml(SINGLE);
    expect(violations(out)).toEqual([]);
    expect(out).not.toContain("'onclick");
    expect(out).toContain('%27onclick');
  });

  it('a quote in the label cannot inject an attribute', () => {
    const out = mdInlineHtml(LABEL);
    expect(violations(out)).toEqual([]);
    // the label stays visible text: its quote is an entity, so it is inside
    // the element, not inside the opening tag
    expect(out).toContain('a&quot; onmouseover=&quot;alert(1)</a>');
    expect(out).not.toContain('" onmouseover="');
  });

  it('renderBodyHtml carries the same protection', () => {
    expect(violations(renderBodyHtml(BREAKOUT), ['p', 'h2', 'h3', 'br'])).toEqual([]);
  });

  it('renderTelegramHtml escapes quotes in the body and in the link list', () => {
    expect(violations(renderTelegramHtml(hostile, 'publish'))).toEqual([]);
  });

  it('renderEmail escapes quotes in the body and in the link list', () => {
    const { html } = renderEmail(hostile, 'publish');
    // {{UNSUBSCRIBE}} is a placeholder the mail adapter substitutes, so the
    // template's own anchors are excluded from the href check by matching
    // only the part of the document the author controls.
    const body = html.split('<hr')[0];
    expect(violations(body, ['div', 'p', 'h1', 'br', 'ul', 'li', 'strong'])).toEqual([]);
  });

  it('an apostrophe in the url does not become an undocumented entity', () => {
    // Telegram HTML mode documents &lt; &gt; &amp; &quot; only; &#39; must
    // never reach it, in text or in an href.
    const out = renderTelegramHtml({ ...baseAnnouncement, bodyMd: "Aztec's release" }, 'publish');
    expect(out).not.toContain('&#39;');
    expect(out).toContain("Aztec's release");
  });

  /**
   * An apostrophe is an RFC 3986 sub-delim and is legal unencoded in a path,
   * so these are ordinary links, not attacks. They must keep working: the fix
   * percent-encodes the quote instead of dropping the link to plain text.
   */
  describe('legitimate urls containing a quote still render as links', () => {
    const URLS: Array<[string, string]> = [
      ["https://en.wikipedia.org/wiki/O'Brien", 'https://en.wikipedia.org/wiki/O%27Brien'],
      ["https://en.wikipedia.org/wiki/Hell's_Kitchen", 'https://en.wikipedia.org/wiki/Hell%27s_Kitchen'],
      ["https://www.google.com/search?q=don't", 'https://www.google.com/search?q=don%27t'],
    ];

    for (const [raw, encoded] of URLS) {
      it(`markdown path: ${raw}`, () => {
        expect(mdInlineHtml(`[w](${raw})`)).toBe(`<a href="${encoded}">w</a>`);
      });

      it(`links[] path: ${raw}`, () => {
        const ann = { ...baseAnnouncement, links: [{ label: 'w', url: raw }] };
        expect(renderTelegramHtml(ann, 'publish')).toContain(`<a href="${encoded}">w</a>`);
        expect(renderEmail(ann, 'publish').html).toContain(`<a href="${encoded}">w</a>`);
      });
    }
  });

  it('leaves a legitimate link byte-identical', () => {
    expect(mdInlineHtml('[link](https://example.com/x)'))
      .toBe('<a href="https://example.com/x">link</a>');
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
