/**
 * Slug handling for the author-editable slug field.
 *
 * A slug is a permanent public URL path (`/a/<slug>`), unique on revision 1 by
 * database constraint. Changing one after publication breaks links that are
 * already distributed, so the compose form shows it before the first save and
 * treats it as fixed thereafter.
 */

export const SLUG_MAX = 80;

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
