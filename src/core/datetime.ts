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
  const year = +y, month = +mo, day = +d, hour = +h, minute = +mi, second = s ? +s : 0;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(ms)) return undefined;
  // Date.UTC normalises out-of-range components instead of rejecting them
  // (e.g. day 32 becomes the 1st of the next month, month 13 becomes next
  // January, 31 February becomes 3 March) — a plausible-looking but wrong
  // instant stored without complaint. Comparing the constructed date's UTC
  // components back against what was parsed catches every such rollover
  // (day, month, hour) with one check, and correctly handles month-length
  // and leap years since the rollover is exactly what changes the readback.
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return check.toISOString();
}

/** ISO instant -> a datetime-local value showing the UTC wall-clock time. */
export function isoToUtcInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}
