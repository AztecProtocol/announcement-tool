import type { Announcement, DeliveryKind, Network, Severity } from './types.js';
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
 * Escape for HTML text content, and for a double-quoted attribute value.
 * The double quote is not optional: this output is inserted into href
 * attributes (mdInlineHtml, renderTelegramHtml, renderEmail), and an
 * unescaped quote there closes the attribute and lets author-supplied text
 * become an event handler.
 *
 * The apostrophe is deliberately NOT escaped here. This same output is the
 * Telegram Bot API payload, whose HTML parse mode documents only &lt; &gt;
 * &amp; and &quot;. Emitting &#39; in ordinary prose ("Aztec's v5.1.0") would
 * gamble the whole Telegram delivery on an undocumented entity: if the
 * parser rejected it, the send would throw, fanout would mark the row failed
 * and burn every retry to exhausted, and the announcement would silently
 * never reach Telegram. Text content therefore keeps a literal apostrophe,
 * which is what it always carried and is harmless outside an attribute.
 * Attribute values get the apostrophe handled separately — see
 * escapeAttrUrl — because only there can it matter.
 */
const escapeHtml = (s: string) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * A markdown heading line: 2-3 leading hashes, then a space, at line start.
 * Requiring the space keeps "issue #123" and "C#" from matching, and anchoring
 * to line start keeps a mid-line "##" literal. A single "#" is deliberately
 * excluded: the compose toolbar only ever inserts "## ", so a lone "#" has no
 * canonical level to render as (see the round-trip regression tests).
 */
export const HEADING_RE = /^(#{2,3})[ \t]+(.+?)[ \t]*$/;

/**
 * A markdown link we render: [label](http(s) URL). The URL may hold one level
 * of balanced parentheses (en.wikipedia.org/wiki/Foo_(bar)), so the closing
 * ")" of the link is not mistaken for part of the URL or left behind as
 * text. Anything else (javascript:, data:, unbalanced parentheses) does not
 * match and stays literal. Used by every renderer here and by the
 * link-preview summary (src/web/link-preview.ts), so they agree on what is a
 * link. app/admin/preview-render.ts cannot import it (client bundle boundary)
 * and keeps a hand-made copy; test/preview-render.test.ts checks that the two
 * sources are identical. The /g flag is safe to share: here it is only used
 * with String.prototype.replace, which resets lastIndex.
 */
export const MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g;

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
    .replace(MD_LINK_RE, '$1: $2');
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
 * A URL that is safe to place in an href. Deliberately stricter than the
 * markdown pattern: http(s) only, and no character that could terminate the
 * attribute or the tag. Applied AFTER escapeAttrUrl has percent-encoded the
 * quotes, so reaching this check with a quote still present means something
 * upstream changed — it is the belt to escapeHtml's braces, so a future edit
 * to either does not silently reopen the hole.
 */
const SAFE_URL_RE = /^https?:\/\/[^"'<>\s]+$/;

/**
 * Undo escapeHtml, so a URL captured out of already-escaped markdown is judged
 * as the author actually wrote it. Without this the SAFE_URL_RE check is a
 * no-op on the one input it exists for: by the time the link pattern runs, a
 * hostile `"` is already `&quot;`, which contains no character SAFE_URL_RE
 * rejects. &amp; is decoded last so "&amp;quot;" becomes the literal
 * "&quot;" and not a quote.
 *
 * Only mdInlineHtml needs this. See the note in linkAnchor.
 */
const unescapeHtml = (s: string) => s
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/**
 * A raw URL → the form that goes inside a double-quoted href.
 *
 * Quotes are percent-encoded rather than rejected. Both are legal unencoded in
 * a path: `'` is an RFC 3986 sub-delim, and real links carry it —
 * en.wikipedia.org/wiki/O'Brien, .../Hell's_Kitchen, a search for don't. An
 * earlier version dropped those to plain text, which broke ordinary content to
 * fix a security bug. %27 and %22 resolve to the same resource and cannot
 * terminate an attribute, so encoding keeps the link working and still closes
 * the hole. `&` is left alone here; escapeHtml turns it into &amp; afterwards.
 */
const escapeAttrUrl = (url: string) => url
  .replace(/'/g, '%27')
  .replace(/"/g, '%22');

/**
 * Convert our supported markdown to inline HTML. Pair-wise regexes only:
 * an unmatched ** or backtick stays literal, so emitted tags always balance
 * (Telegram would reject a malformed entity; email clients render it wrong).
 */
export function mdInlineHtml(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    // Two layers, both deliberate. escapeHtml has already run, so a quote the
    // author wrote is now &quot; and cannot close the attribute — that alone
    // makes the output safe. On top of it the URL is decoded back to what the
    // author typed, its quotes percent-encoded, and the result held to
    // SAFE_URL_RE; that check is what stops javascript: and data: should a
    // later edit loosen the pattern above. The decode is required because the
    // escaped form hides the very characters both steps look for. A URL that
    // still fails is left as literal markdown text.
    .replace(MD_LINK_RE, (whole, label: string, url: string) => {
      const href = escapeAttrUrl(unescapeHtml(url));
      return SAFE_URL_RE.test(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : whole;
    });
}

/**
 * One entry of the links list as an anchor, for the Telegram and email
 * renderers. Same two layers as the markdown link replacement above, and the
 * same reason: quotes percent-encoded so a quote cannot close the attribute,
 * then SAFE_URL_RE as the independent check, and a URL that still fails
 * degrades to "label: url" as plain escaped text rather than becoming an href.
 *
 * One difference from mdInlineHtml: this receives a.links[].url straight from
 * the record, which has never been through escapeHtml, so it must NOT decode
 * first. Adding an unescapeHtml call here would be a real false-accept — an
 * author-supplied literal "&quot;" would decode into a live quote.
 */
function linkAnchor(l: { label: string; url: string }): string {
  const label = escapeHtml(l.label);
  const href = escapeAttrUrl(l.url);
  if (!SAFE_URL_RE.test(href)) return `${label}: ${escapeHtml(l.url)}`;
  return `<a href="${escapeHtml(href)}">${label}</a>`;
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
 * escapeHtml also escapes the double quote, which the href attributes below
 * need and which Telegram documents. The apostrophe is left literal in text
 * for the reason given on escapeHtml; in an href it is percent-encoded, so no
 * undocumented entity ever reaches the Bot API.
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

/**
 * Severity colours in email (all ≥ 6:1 on white). They mirror --critical,
 * --recommended and --info in app/globals.css; email cannot read CSS custom
 * properties, so the hexes are repeated here. Change both together.
 */
export const EMAIL_SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  critical: '#a8180f',
  recommended: '#7a5a06',
  info: '#12405e',
};

// Opaque Paper-ground PNG (192 x 44, no alpha) shown at 96 x 22: a
// transparent Ink mark would vanish in dark-mode mail clients, and Outlook
// desktop does not render SVG. alt="Aztec" stands in when images are blocked.
const emailWordmark = () =>
  `<img src="${escapeHtml(`${publicBaseUrl()}/brand/email/aztec-wordmark-ink@2x.png`)}" width="96" height="22" alt="Aztec" style="display:block;border:0">`;

// One-cell tables, not divs: Outlook desktop ignores background and
// border-left on <div>. It also ignores margin on <table>, so the space below
// each table is a spacer row of fixed height.
const TABLE = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">';
const spacerRow = (px: number) => `<tr><td height="${px}" style="font-size:0;line-height:0">&nbsp;</td></tr>`;

export function renderEmail(a: Announcement, kind: DeliveryKind): { subject: string; text: string; html: string } {
  // Fallback for a severity outside the type (a stale row, a future value):
  // the info colour, never an empty `border-left:4px solid undefined`.
  const sev = EMAIL_SEVERITY_COLOR[a.severity] ?? EMAIL_SEVERITY_COLOR.info;
  const actions = a.actionsRequired.length
    ? TABLE + `<tr><td style="border-left:4px solid ${sev};padding:4px 0 4px 14px">`
      + `<p style="margin:0 0 2px;font-size:12px;font-weight:700;letter-spacing:.06em;color:${sev}">${escapeHtml(String(a.severity).toUpperCase())}</p>`
      + `<p style="margin:0 0 4px"><strong>Action required:</strong></p>`
      + `<ul style="margin:0;padding-left:20px">`
      + a.actionsRequired.map(act => {
          const parts = [escapeHtml(act.action)];
          if (act.deadline) parts.push(`by <strong>${escapeHtml(formatDeadline(act.deadline))}</strong>`);
          if (act.applies_to.length) parts.push(`(${escapeHtml(act.applies_to.join(', '))})`);
          return `<li style="margin:0 0 4px">${parts.join(' ')}</li>`;
        }).join('')
      + `</ul>`
      + `</td></tr>${spacerRow(12)}</table>`
    : '';
  const links = a.links.length
    ? `<p style="margin:0 0 12px">${a.links.map(linkAnchor).join(' · ')}</p>`
    : '';
  // Inline styles + fixed light colors on purpose: email clients ignore <style>
  // blocks unpredictably and handle dark mode themselves.
  const html = [
    `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#141900;max-width:600px;margin:0 auto;padding:16px">`,
    `${TABLE}<tr><td bgcolor="#fff9f2" style="background:#fff9f2;padding:14px 16px">${emailWordmark()}</td></tr>${spacerRow(16)}</table>`,
    `<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.04em;color:#626554;margin:0 0 12px">${escapeHtml(`${kindPrefix(kind)}${tagLine(a)}`)}</p>`,
    `<h1 style="font-size:19px;line-height:1.35;margin:0 0 12px">${escapeHtml(a.title)}</h1>`,
    renderBodyHtml(a.bodyMd),
    actions,
    links,
    `<p style="margin:0 0 12px"><a href="${canonicalUrl(a)}">View this announcement</a></p>`,
    `<hr style="border:none;border-top:1px solid #e8e8e6;margin:16px 0">`,
    `<p style="font-size:12px;color:#626554;margin:0">You receive this because you subscribed to Aztec release announcements. <a href="{{UNSUBSCRIBE}}" style="color:#626554">Manage preferences or unsubscribe</a></p>`,
    `</div>`,
  ].join('\n');
  return {
    subject: `${kindPrefix(kind)}${tagLine(a)} ${a.title}`,
    text: `${renderPlain(a, kind)}\n\n—\nYou receive this because you subscribed to Aztec release announcements.\nManage preferences or unsubscribe: {{UNSUBSCRIBE}}\n`,
    html,
  };
}
