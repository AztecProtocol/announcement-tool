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

function actionLines(a: Announcement, bullet: string): string[] {
  if (a.actionsRequired.length === 0) return [];
  const lines = [`Action required:`];
  for (const act of a.actionsRequired) {
    const parts = [`${bullet}${act.action}`];
    if (act.deadline) parts.push(`by ${act.deadline}`);
    if (act.applies_to.length) parts.push(`(${act.applies_to.join(', ')})`);
    lines.push(parts.join(' '));
  }
  return lines;
}

function linkLines(a: Announcement): string[] {
  return a.links.map(l => `${l.label}: ${l.url}`);
}

export function renderPlain(a: Announcement, kind: DeliveryKind): string {
  return [
    `${kindPrefix(kind)}${tagLine(a)}`,
    '',
    a.title,
    '',
    a.bodyMd,
    ...(a.actionsRequired.length ? ['', ...actionLines(a, '- ')] : []),
    ...(a.links.length ? ['', ...linkLines(a)] : []),
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

export function renderEmail(a: Announcement, kind: DeliveryKind): { subject: string; text: string } {
  return {
    subject: `${kindPrefix(kind)}${tagLine(a)} ${a.title}`,
    text: `${renderPlain(a, kind)}\n\n—\nYou receive this because you subscribed to Aztec release announcements.\nManage preferences or unsubscribe: {{UNSUBSCRIBE}}\n`,
  };
}
