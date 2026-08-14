import type { Announcement, DeliveryKind, Network } from './types.js';

const NETWORK_ORDER: Network[] = ['mainnet', 'testnet'];

export function canonicalUrl(a: Pick<Announcement, 'slug'>): string {
  const base = (process.env.PUBLIC_BASE_URL ?? 'https://announce.aztec.foundation').replace(/\/+$/, '');
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

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A markdown heading line: 1-3 leading hashes, then a space, at line start.
 * Requiring the space keeps "issue #123" and "C#" from matching, and anchoring
 * to line start keeps a mid-line "##" literal.
 */
const HEADING_RE = /^(#{1,3})[ \t]+(.+?)[ \t]*$/;

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
export function mdInlineHtml(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
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
        const level = Math.min(h[1].length, 3); // ## → h2, ### → h3
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
 */
export function renderTelegramHtml(a: Announcement, kind: DeliveryKind): string {
  return [
    escapeHtml(`${kindPrefix(kind)}${tagLine(a)}`),
    '',
    `<b>${escapeHtml(a.title)}</b>`,
    '',
    telegramBodyHtml(a.bodyMd),
    ...(a.actionsRequired.length ? ['', ...actionLines(a, '- ').map(escapeHtml)] : []),
    ...(a.links.length ? ['', ...a.links.map(l => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`)] : []),
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
    ? `<p style="margin:0 0 12px">${a.links.map(l => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(' · ')}</p>`
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
