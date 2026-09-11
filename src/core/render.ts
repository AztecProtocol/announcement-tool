import type { Announcement, DeliveryKind, Network } from './types.js';
import { publicBaseUrl } from './public-base-url.js';

const NETWORK_ORDER: Network[] = ['mainnet', 'testnet'];

export function canonicalUrl(a: Pick<Announcement, 'slug'>): string {
  const base = publicBaseUrl();
  return `${base}/a/${a.slug}`;
}

export function tagLine(a: Pick<Announcement, 'networks' | 'severity' | 'type'>): string {
  const nets = NETWORK_ORDER.filter(n => a.networks.includes(n));
  return [...nets, a.severity, a.type].map(t => `[${t.toUpperCase()}]`).join(' ');
}

export function kindPrefix(kind: DeliveryKind): string {
  return kind === 'update' ? 'UPDATED: ' : kind === 'reminder' ? 'REMINDER: ' : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * ISO timestamp → "24 Aug 2026, 10:56 UTC" for human-facing channels.
 * Deliberately explicit about UTC and unambiguous about day/month order, since
 * readers are worldwide. Machine surfaces (webhook JSON, feeds) keep raw ISO.
 * Returns the input unchanged if it isn't parseable.
 */
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function actionLines(a: Announcement, bullet: string): string[] {
  if (a.actionsRequired.length === 0) return [];
  const lines = [`Action required:`];
  for (const act of a.actionsRequired) {
    const parts = [`${bullet}${act.action}`];
    if (act.deadline) parts.push(`by ${formatDeadline(act.deadline)}`);
    if (act.applies_to.length) parts.push(`(${act.applies_to.join(', ')})`);
    lines.push(parts.join(' '));
  }
  return lines;
}

function linkLines(a: Announcement): string[] {
  return a.links.map(l => `${l.label}: ${l.url}`);
}

/**
 * Escape for HTML text content AND for a double- or single-quoted attribute
 * value. The quotes are not optional: this output is inserted into href
 * attributes (mdInlineHtml, renderTelegramHtml, renderEmail), and an
 * unescaped quote there closes the attribute and lets author-supplied text
 * become an event handler. &#39; rather than &apos; because &apos; is not in
 * the HTML 4 entity set and some mail clients render it literally.
 */
const escapeHtml = (s: string) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * A markdown heading line: 2-3 leading hashes, then a space, at line start.
 * Requiring the space keeps "issue #123" and "C#" from matching, and anchoring
 * to line start keeps a mid-line "##" literal. A single "#" is deliberately
 * excluded: the compose toolbar only ever inserts "## ", so a lone "#" has no
 * canonical level to render as (see the round-trip regression tests).
 */
const HEADING_RE = /^(#{2,3})[ \t]+(.+?)[ \t]*$/;

/**
 * Strip the markdown we support (bold, inline code, links) for plain-text
 * channels, so literal ** and backticks never reach a reader.
 * Also converts headings to uppercase lines without markers.
 */
export function stripMarkdown(md: string): string {
  return md
    .split('\n')
    .map(line => {
      const h = HEADING_RE.exec(line);
      return h ? h[2].toUpperCase() : line;
    })
    .join('\n')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2');
}

/**
 * Telegram HTML mode supports no heading tag, so a heading line becomes a bold
 * line. Applied per line before inline conversion, hence the explicit escape.
 */
export function headingToBold(md: string): string {
  return md
    .split('\n')
    .map(line => {
      const h = HEADING_RE.exec(line);
      return h ? `<b>${escapeHtml(h[2])}</b>` : line;
    })
    .join('\n');
}

/**
 * Convert our supported markdown to inline HTML. Pair-wise regexes only:
 * an unmatched ** or backtick stays literal, so emitted tags always balance
 * (Telegram would reject a malformed entity; email clients render it wrong).
 */
/**
 * A URL that is safe to place in an href. Deliberately stricter than the
 * markdown pattern: http(s) only, and no character that could terminate the
 * attribute or the tag. The markdown pattern already excludes whitespace and
 * ")", and escapeHtml has already neutralised <, > and the quotes — this is
 * the belt to that braces, so a future change to either does not silently
 * reopen the hole.
 */
const SAFE_URL_RE = /^https?:\/\/[^"'<>\s]+$/;

/**
 * Undo escapeHtml, so SAFE_URL_RE judges the URL the author actually wrote.
 * Without this the check is a no-op on the one input it exists for: by the
 * time the link pattern runs, a hostile `"` is already `&quot;`, which
 * contains no character SAFE_URL_RE rejects. &amp; is unescaped last so
 * "&amp;quot;" decodes to the literal "&quot;" and not to a quote.
 */
const unescapeHtml = (s: string) => s
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

export function mdInlineHtml(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    // Two layers, both deliberate. escapeHtml has already run, so a quote the
    // author wrote is now &quot; and cannot close the attribute — that alone
    // makes the output safe. The re-validation on top rejects the link
    // outright rather than emitting an href full of escaped handler text, and
    // it is what stops javascript: and data: should a later edit loosen the
    // pattern above. It runs on the decoded URL, because the escaped form
    // hides the very characters it looks for. A URL that fails is left as
    // literal markdown text.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (whole, label: string, url: string) =>
      SAFE_URL_RE.test(unescapeHtml(url)) ? `<a href="${url}">${label}</a>` : whole);
}

/**
 * One entry of the links list as an anchor, for the Telegram and email
 * renderers. Both values are escaped, so neither can close the attribute; the
 * URL is additionally held to SAFE_URL_RE, and a link that fails it degrades
 * to "label: url" as plain escaped text rather than becoming an href. Same two
 * layers, and same reason, as the markdown link replacement above.
 */
function linkAnchor(l: { label: string; url: string }): string {
  const label = escapeHtml(l.label);
  if (!SAFE_URL_RE.test(l.url)) return `${label}: ${escapeHtml(l.url)}`;
  return `<a href="${escapeHtml(l.url)}">${label}</a>`;
}

/** Body → Telegram HTML: headings to bold lines, everything else inline-converted. */
function telegramBodyHtml(md: string): string {
  return md
    .split('\n')
    .map(line => (HEADING_RE.test(line) ? headingToBold(line) : mdInlineHtml(line)))
    .join('\n');
}

/** Markdown body → HTML paragraphs (blank line = new paragraph); headings → h2/h3. */
export function renderBodyHtml(md: string): string {
  return md.split(/\n{2,}/)
    .map(p => {
      const h = HEADING_RE.exec(p.trim());
      if (h && !p.trim().includes('\n')) {
        const level = h[1].length; // ## → h2, ### → h3
        const size = level === 2 ? 16 : 14;
        return `<h${level} style="font-size:${size}px;line-height:1.35;margin:16px 0 8px">`
          + `${escapeHtml(h[2])}</h${level}>`;
      }
      return `<p style="margin:0 0 12px">${mdInlineHtml(p).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

export function renderPlain(a: Announcement, kind: DeliveryKind): string {
  return [
    `${kindPrefix(kind)}${tagLine(a)}`,
    '',
    a.title,
    '',
    stripMarkdown(a.bodyMd),
    ...(a.actionsRequired.length ? ['', ...actionLines(a, '- ')] : []),
    ...(a.links.length ? ['', ...linkLines(a)] : []),
    '',
    canonicalUrl(a),
  ].join('\n');
}

/**
 * Telegram rendering uses HTML parse mode: unlike MarkdownV2 (18 characters to
 * escape, one miss rejects the message), HTML needs only &, <, > escaped —
 * which escapeHtml does completely — and gives real bold and clickable links.
 * escapeHtml also escapes the quotes, which Telegram does not require but the
 * href attributes below do; Telegram decodes &quot; and &#39; normally.
 */
export function renderTelegramHtml(a: Announcement, kind: DeliveryKind): string {
  return [
    escapeHtml(`${kindPrefix(kind)}${tagLine(a)}`),
    '',
    `<b>${escapeHtml(a.title)}</b>`,
    '',
    telegramBodyHtml(a.bodyMd),
    ...(a.actionsRequired.length ? ['', ...actionLines(a, '- ').map(escapeHtml)] : []),
    ...(a.links.length ? ['', ...a.links.map(linkAnchor)] : []),
    '',
    canonicalUrl(a),
  ].join('\n');
}

export function renderMarkdown(a: Announcement, kind: DeliveryKind): string {
  return [
    `${kindPrefix(kind)}${tagLine(a)}`,
    '',
    `**${a.title}**`,
    '',
    a.bodyMd,
    ...(a.actionsRequired.length ? ['', ...actionLines(a, '- ')] : []),
    ...(a.links.length ? ['', ...a.links.map(l => `[${l.label}](${l.url})`)] : []),
    '',
    canonicalUrl(a),
  ].join('\n');
}

export function renderEmail(a: Announcement, kind: DeliveryKind): { subject: string; text: string; html: string } {
  const actions = a.actionsRequired.length
    ? `<p style="margin:0 0 4px"><strong>Action required:</strong></p>`
      + `<ul style="margin:0 0 12px;padding-left:20px">`
      + a.actionsRequired.map(act => {
          const parts = [escapeHtml(act.action)];
          if (act.deadline) parts.push(`by <strong>${escapeHtml(formatDeadline(act.deadline))}</strong>`);
          if (act.applies_to.length) parts.push(`(${escapeHtml(act.applies_to.join(', '))})`);
          return `<li style="margin:0 0 4px">${parts.join(' ')}</li>`;
        }).join('')
      + `</ul>`
    : '';
  const links = a.links.length
    ? `<p style="margin:0 0 12px">${a.links.map(linkAnchor).join(' · ')}</p>`
    : '';
  // Inline styles + fixed light colors on purpose: email clients ignore <style>
  // blocks unpredictably and handle dark mode themselves.
  const html = [
    `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c2130;max-width:600px;margin:0 auto;padding:16px">`,
    `<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.04em;color:#6b7280;margin:0 0 12px">${escapeHtml(`${kindPrefix(kind)}${tagLine(a)}`)}</p>`,
    `<h1 style="font-size:19px;line-height:1.35;margin:0 0 12px">${escapeHtml(a.title)}</h1>`,
    renderBodyHtml(a.bodyMd),
    actions,
    links,
    `<p style="margin:0 0 12px"><a href="${canonicalUrl(a)}">View this announcement</a></p>`,
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">`,
    `<p style="font-size:12px;color:#6b7280;margin:0">You receive this because you subscribed to Aztec release announcements. <a href="{{UNSUBSCRIBE}}" style="color:#6b7280">Manage preferences or unsubscribe</a></p>`,
    `</div>`,
  ].join('\n');
  return {
    subject: `${kindPrefix(kind)}${tagLine(a)} ${a.title}`,
    text: `${renderPlain(a, kind)}\n\n—\nYou receive this because you subscribed to Aztec release announcements.\nManage preferences or unsubscribe: {{UNSUBSCRIBE}}\n`,
    html,
  };
}
