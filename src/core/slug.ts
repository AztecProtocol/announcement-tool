/**
 * Slug handling for the author-editable slug field.
 *
 * A slug is a permanent public URL path (`/a/<slug>`), unique on revision 1 by
 * database constraint. Changing one after publication breaks links that are
 * already distributed, so the compose form shows it before the first save and
 * treats it as fixed thereafter.
 *
 * This module is imported by the compose form, which is a client component.
 * Keep it free of Node built-ins: a `node:crypto` import here would be
 * polyfilled into the browser bundle, and that polyfill evaluates strings,
 * which the Content-Security-Policy refuses.
 */

export const SLUG_MAX = 80;

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

/** Free text -> a URL-safe slug. Mirrors the shape makeSlug produces. */
export function normalizeSlug(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= SLUG_MAX) return s;
  const cut = s.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/** Human-readable reason a slug is unusable, or undefined when it is fine. */
export function slugError(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return 'Slug is required.';
  if (s.length > SLUG_MAX) return `Slug must be ${SLUG_MAX} characters or fewer.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
    return 'Use lowercase letters, numbers and single hyphens only.';
  }
  return undefined;
}
