/**
 * ALERT_EMAIL_TO may name several people. One rule, shared by the app and
 * (re-implemented in bash) by scripts/send-alert.sh: split on commas, trim,
 * drop empties, drop exact duplicates, keep order.
 */
export function parseRecipients(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
