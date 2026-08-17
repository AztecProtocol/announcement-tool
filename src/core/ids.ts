import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';

export const newAnnouncementId = () => `ann_${ulid()}`;
export const newSubscriptionId = () => `sub_${ulid()}`;
export const newTemplateId = () => `tpl_${ulid()}`;
export const newSecret = () => `whsec_${randomBytes(24).toString('hex')}`;
export const newToken = () => randomBytes(16).toString('hex');

export function makeSlug(date: Date, type: string, title: string): string {
  const ym = date.toISOString().slice(0, 7);
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean);
  // A title that already opens with its type ("Upgrade to v5.2.0", type
  // "upgrade") would otherwise produce "…-upgrade-upgrade-to-…".
  if (words[0] === type.toLowerCase()) words.shift();
  const stem = `${ym}-${type}`;
  const out: string[] = [];
  // Capped at 5 words (not 7): the "does not repeat the type" test case
  // ("Upgrade to v5.2.0 required by 2026-08-28", type "upgrade") expects
  // '2026-08-upgrade-to-v5-2-0-required' — 5 words after the type is
  // shifted off. A 7-word cap would additionally include "by-2026".
  for (const w of words.slice(0, 5)) {
    if (`${stem}-${[...out, w].join('-')}`.length > 80) break;
    out.push(w);
  }
  return out.length ? `${stem}-${out.join('-')}` : stem;
}
