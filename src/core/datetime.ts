/**
 * `<input type="datetime-local">` has no timezone: the browser interprets its
 * value in the viewer's local zone, so the same typed time produced different
 * instants for different authors. Announcement deadlines are UTC by convention
 * and are the field operators act on, so the form treats what is typed as UTC
 * and these helpers do the conversion explicitly — never via `new Date(value)`,
 * which would reintroduce the local-zone dependency.
 */

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A datetime-local value, read as UTC -> ISO instant. */
export function utcInputToIso(value: string): string | undefined {
  const m = INPUT_RE.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** ISO instant -> a datetime-local value showing the UTC wall-clock time. */
export function isoToUtcInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}
