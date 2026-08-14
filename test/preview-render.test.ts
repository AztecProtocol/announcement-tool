import { describe, it, expect } from 'vitest';
import { parseMarkdownBlocks, parseTelegramHtml, parseMentions } from '../app/admin/preview-render.js';

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
});
