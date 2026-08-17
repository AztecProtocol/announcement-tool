import { describe, it, expect } from 'vitest';
import { parseMarkdownBlocks, parseTelegramHtml, parseMentions } from '../app/admin/preview-render.js';
import { renderMarkdown, renderTelegramHtml } from '../src/core/render.js';
import type { Announcement } from '../src/core/types.js';

describe('parseMarkdownBlocks', () => {
  it('reads a heading', () => {
    expect(parseMarkdownBlocks('## What changes')).toEqual([
      { kind: 'heading', level: 2, text: 'What changes' },
    ]);
  });

  it('reads a level-three heading', () => {
    expect(parseMarkdownBlocks('### Smaller')).toEqual([
      { kind: 'heading', level: 3, text: 'Smaller' },
    ]);
  });

  it('reads bullets', () => {
    const out = parseMarkdownBlocks('- first\n- second');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: 'bullet', spans: [{ kind: 'text', text: 'first' }] });
  });

  it('splits inline bold, code and links', () => {
    const [block] = parseMarkdownBlocks('use **v5.2.0** with `--flag` see [docs](https://x.io)');
    expect(block.kind).toBe('para');
    expect((block as { spans: unknown[] }).spans).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'bold', text: 'v5.2.0' },
      { kind: 'text', text: ' with ' },
      { kind: 'code', text: '--flag' },
      { kind: 'text', text: ' see ' },
      { kind: 'link', text: 'docs', href: 'https://x.io' },
    ]);
  });

  it('recognises the leading tag line', () => {
    const [block] = parseMarkdownBlocks('[MAINNET] [CRITICAL] [UPGRADE]');
    expect(block).toEqual({ kind: 'tag', text: '[MAINNET] [CRITICAL] [UPGRADE]' });
  });

  it('recognises a tag line carrying an update prefix', () => {
    const [block] = parseMarkdownBlocks('UPDATED: [MAINNET] [CRITICAL] [UPGRADE]');
    expect(block).toEqual({ kind: 'tag', text: 'UPDATED: [MAINNET] [CRITICAL] [UPGRADE]' });
  });

  it('recognises a tag line carrying a reminder prefix', () => {
    const [block] = parseMarkdownBlocks('REMINDER: [MAINNET] [CRITICAL] [UPGRADE]');
    expect(block).toEqual({ kind: 'tag', text: 'REMINDER: [MAINNET] [CRITICAL] [UPGRADE]' });
  });

  it('does not treat arbitrary prefixed text as a tag line', () => {
    const [block] = parseMarkdownBlocks('NOTE: [MAINNET] [CRITICAL]');
    expect(block.kind).toBe('para');
  });

  it('leaves an unmatched marker literal', () => {
    const [block] = parseMarkdownBlocks('a ** dangling');
    expect((block as { spans: unknown[] }).spans).toEqual([{ kind: 'text', text: 'a ** dangling' }]);
  });

  it('treats a blank line as a block break', () => {
    expect(parseMarkdownBlocks('one\n\ntwo')).toHaveLength(2);
  });
});

describe('parseTelegramHtml', () => {
  it('reads a bold line as a heading-like bold block', () => {
    const [block] = parseTelegramHtml('<b>What changes</b>');
    expect(block).toEqual({ kind: 'para', spans: [{ kind: 'bold', text: 'What changes' }] });
  });

  it('reads code and links', () => {
    const [block] = parseTelegramHtml('run <code>--flag</code> at <a href="https://x.io">docs</a>');
    expect((block as { spans: unknown[] }).spans).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: '--flag' },
      { kind: 'text', text: ' at ' },
      { kind: 'link', text: 'docs', href: 'https://x.io' },
    ]);
  });

  it('unescapes entities back to characters', () => {
    const [block] = parseTelegramHtml('a &lt;b&gt; &amp; c');
    expect((block as { spans: { text: string }[] }).spans[0].text).toBe('a <b> & c');
  });

  it('recognises an update-prefixed tag line in telegram html', () => {
    const [block] = parseTelegramHtml('UPDATED: [MAINNET] [CRITICAL] [UPGRADE]');
    expect(block).toEqual({ kind: 'tag', text: 'UPDATED: [MAINNET] [CRITICAL] [UPGRADE]' });
  });
});

describe('parseMentions', () => {
  it('splits role mentions from surrounding text', () => {
    expect(parseMentions('@Mainnet Sequencer heads up <@&12345> now')).toEqual([
      { kind: 'text', text: '@Mainnet Sequencer heads up ' },
      { kind: 'bold', text: '<@&12345>' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('returns a single text span when there is no mention', () => {
    expect(parseMentions('plain prefix')).toEqual([{ kind: 'text', text: 'plain prefix' }]);
  });

  it('labels a role mention with its configured name', () => {
    const roles = [{ name: 'mainnet-sequencer', id: '1538890653835075584' }];
    const spans = parseMentions('<@&1538890653835075584> 🇦🇿', roles);
    expect(spans[0]).toEqual({ kind: 'bold', text: '@mainnet-sequencer' });
  });

  it('falls back to the raw token for an unknown id', () => {
    const spans = parseMentions('<@&999>', [{ name: 'other', id: '111' }]);
    expect(spans[0]).toEqual({ kind: 'bold', text: '<@&999>' });
  });

  it('still labels @everyone and @here', () => {
    expect(parseMentions('@everyone')[0]).toEqual({ kind: 'bold', text: '@everyone' });
  });
});

/**
 * Round-trip: feed the REAL renderer output into the REAL parser, instead of
 * hand-writing input strings. This is the regression guard for the level
 * mismatch at '#' that six per-task reviews missed, because every prior test
 * on either side only ever exercised its own hand-written fixture.
 */
describe('renderer output -> parser round trip', () => {
  const baseAnnouncement: Announcement = {
    id: 'ann_R', revision: 1, slug: '2026-08-upgrade-v5-1-0', type: 'upgrade',
    networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
    title: 'Upgrade to v5.1.0 by 2026-08-20 14:00 UTC',
    bodyMd: '',
    actionsRequired: [],
    links: [],
    status: 'published', createdBy: 'a@x', publishedAt: '2026-08-06T10:00:00Z',
  };

  const withBody = (bodyMd: string): Announcement => ({ ...baseAnnouncement, bodyMd });

  describe('markdown channel (renderMarkdown -> parseMarkdownBlocks)', () => {
    it('reads a level-2 heading', () => {
      const wire = renderMarkdown(withBody('## What changes'), 'publish');
      const blocks = parseMarkdownBlocks(wire);
      expect(blocks).toContainEqual({ kind: 'heading', level: 2, text: 'What changes' });
    });

    it('reads a level-3 heading', () => {
      const wire = renderMarkdown(withBody('### Smaller'), 'publish');
      const blocks = parseMarkdownBlocks(wire);
      expect(blocks).toContainEqual({ kind: 'heading', level: 3, text: 'Smaller' });
    });

    it('does not treat a single-hash line as a heading', () => {
      const wire = renderMarkdown(withBody('# Top'), 'publish');
      const blocks = parseMarkdownBlocks(wire);
      expect(blocks.some(b => b.kind === 'heading')).toBe(false);
    });

    it('reads the tag line as a tag block', () => {
      const wire = renderMarkdown(withBody('body'), 'publish');
      const blocks = parseMarkdownBlocks(wire);
      expect(blocks[0]).toEqual({ kind: 'tag', text: '[MAINNET] [CRITICAL] [UPGRADE]' });
    });

    it('reads an update-prefixed tag line as a tag block', () => {
      const wire = renderMarkdown(withBody('body'), 'update');
      const blocks = parseMarkdownBlocks(wire);
      expect(blocks[0]).toEqual({ kind: 'tag', text: 'UPDATED: [MAINNET] [CRITICAL] [UPGRADE]' });
    });

    it('reads a bullet', () => {
      const wire = renderMarkdown(withBody('- first step'), 'publish');
      const blocks = parseMarkdownBlocks(wire);
      expect(blocks).toContainEqual({ kind: 'bullet', spans: [{ kind: 'text', text: 'first step' }] });
    });

    it('reads an inline run of bold, code and link', () => {
      const wire = renderMarkdown(withBody('use **v5.2.0** with `--flag` see [docs](https://x.io)'), 'publish');
      const blocks = parseMarkdownBlocks(wire);
      const para = blocks.find(
        b => b.kind === 'para' && b.spans.some(s => s.kind === 'code' && s.text === '--flag'),
      );
      expect(para).toEqual({
        kind: 'para',
        spans: [
          { kind: 'text', text: 'use ' },
          { kind: 'bold', text: 'v5.2.0' },
          { kind: 'text', text: ' with ' },
          { kind: 'code', text: '--flag' },
          { kind: 'text', text: ' see ' },
          { kind: 'link', text: 'docs', href: 'https://x.io' },
        ],
      });
    });
  });

  describe('telegram channel (renderTelegramHtml -> parseTelegramHtml)', () => {
    it('reads a level-2 heading as a bold block', () => {
      const wire = renderTelegramHtml(withBody('## What changes'), 'publish');
      const blocks = parseTelegramHtml(wire);
      expect(blocks).toContainEqual({ kind: 'para', spans: [{ kind: 'bold', text: 'What changes' }] });
    });

    it('reads a level-3 heading as a bold block', () => {
      const wire = renderTelegramHtml(withBody('### Smaller'), 'publish');
      const blocks = parseTelegramHtml(wire);
      expect(blocks).toContainEqual({ kind: 'para', spans: [{ kind: 'bold', text: 'Smaller' }] });
    });

    it('does not bold a single-hash line as a heading', () => {
      const wire = renderTelegramHtml(withBody('# Top'), 'publish');
      const blocks = parseTelegramHtml(wire);
      const hasHeadingLikeBold = blocks.some(
        b => b.kind === 'para' && b.spans.length === 1 && b.spans[0].kind === 'bold' && b.spans[0].text === 'Top',
      );
      expect(hasHeadingLikeBold).toBe(false);
    });

    it('reads the tag line as a tag block, including the reminder prefix', () => {
      const wire = renderTelegramHtml(withBody('body'), 'reminder');
      const blocks = parseTelegramHtml(wire);
      expect(blocks[0]).toEqual({ kind: 'tag', text: 'REMINDER: [MAINNET] [CRITICAL] [UPGRADE]' });
    });

    it('reads an inline run of bold, code and link', () => {
      const wire = renderTelegramHtml(withBody('use **v5.2.0** with `--flag` see [docs](https://x.io)'), 'publish');
      const blocks = parseTelegramHtml(wire);
      const para = blocks.find(
        b => b.kind === 'para' && b.spans.some(s => s.kind === 'bold' && s.text === 'v5.2.0'),
      );
      expect(para).toEqual({
        kind: 'para',
        spans: [
          { kind: 'text', text: 'use ' },
          { kind: 'bold', text: 'v5.2.0' },
          { kind: 'text', text: ' with ' },
          { kind: 'code', text: '--flag' },
          { kind: 'text', text: ' see ' },
          { kind: 'link', text: 'docs', href: 'https://x.io' },
        ],
      });
    });
  });
});
