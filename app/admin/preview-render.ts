/**
 * Turns a channel payload string into structured blocks the preview draws.
 *
 * This module NEVER produces the bytes that get sent — it only re-reads the
 * payload that src/core/render.ts already produced, so the rendered view can
 * never drift from the wire format in a way that changes what is delivered.
 * Deliberately React-free so it is unit-testable on its own.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'para'; spans: Inline[] }
  | { kind: 'bullet'; spans: Inline[] }
  | { kind: 'tag'; text: string };

const HEADING_RE = /^(#{1,3})[ \t]+(.+?)[ \t]*$/;
const BULLET_RE = /^[-*][ \t]+(.*)$/;
const TAG_LINE_RE = /^(\[[A-Z0-9 _-]+\][ \t]*)+$/;

/** Inline markdown → spans. Pair-wise like the renderer: an unmatched marker stays literal. */
function markdownSpans(text: string): Inline[] {
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  return collect(text, pattern, m => {
    if (m[1] !== undefined) return { kind: 'bold', text: m[1] };
    if (m[2] !== undefined) return { kind: 'code', text: m[2] };
    return { kind: 'link', text: m[3], href: m[4] };
  });
}

/** Shared scanner: walk matches, emitting plain text between them. */
function collect(
  text: string,
  pattern: RegExp,
  toSpan: (m: RegExpExecArray) => Inline,
): Inline[] {
  const spans: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) spans.push({ kind: 'text', text: text.slice(last, at) });
    spans.push(toSpan(m as RegExpExecArray));
    last = at + m[0].length;
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) });
  return spans.length ? spans : [{ kind: 'text', text: '' }];
}

export function parseMarkdownBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of md.split(/\n{2,}/)) {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue;
      const h = HEADING_RE.exec(line);
      if (h) {
        blocks.push({ kind: 'heading', level: h[1].length >= 3 ? 3 : 2, text: h[2] });
        continue;
      }
      const b = BULLET_RE.exec(line);
      if (b) {
        blocks.push({ kind: 'bullet', spans: markdownSpans(b[1]) });
        continue;
      }
      if (TAG_LINE_RE.test(line.trim())) {
        blocks.push({ kind: 'tag', text: line.trim() });
        continue;
      }
      blocks.push({ kind: 'para', spans: markdownSpans(line) });
    }
  }
  return blocks;
}

const unescapeHtml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Telegram HTML → spans. Only the tags renderTelegramHtml emits: b, code, a. */
function telegramSpans(html: string): Inline[] {
  const pattern = /<b>([\s\S]*?)<\/b>|<code>([\s\S]*?)<\/code>|<a href="([^"]*)">([\s\S]*?)<\/a>/g;
  const spans = collect(html, pattern, m => {
    if (m[1] !== undefined) return { kind: 'bold', text: unescapeHtml(m[1]) };
    if (m[2] !== undefined) return { kind: 'code', text: unescapeHtml(m[2]) };
    return { kind: 'link', text: unescapeHtml(m[4]), href: unescapeHtml(m[3]) };
  });
  return spans.map(s => (s.kind === 'text' ? { kind: 'text', text: unescapeHtml(s.text) } : s));
}

export function parseTelegramHtml(html: string): Block[] {
  const blocks: Block[] = [];
  for (const line of html.split('\n')) {
    if (line.trim() === '') continue;
    if (TAG_LINE_RE.test(unescapeHtml(line).trim())) {
      blocks.push({ kind: 'tag', text: unescapeHtml(line).trim() });
      continue;
    }
    blocks.push({ kind: 'para', spans: telegramSpans(line) });
  }
  return blocks;
}

/**
 * Splits a Discord prefix so mentions can be drawn as pills. Matches both the
 * id form Discord resolves (<@&123>) and the plain @Name form used in the
 * configured prefixes. Emits 'bold' for a mention because the pill styling is
 * applied by the component, which keys off the span kind.
 */
export function parseMentions(prefix: string): Inline[] {
  const pattern = /<@[&!]?\d+>|@(?:everyone|here)/g;
  return collect(prefix, pattern, m => ({ kind: 'bold', text: m[0] }));
}
