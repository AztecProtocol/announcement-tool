/**
 * Best-effort caller address for rate-limiting keys.
 *
 * `x-nf-client-connection-ip` is set by Netlify's edge from the real TCP peer
 * and cannot be forged by the client, so it wins where present. `x-forwarded-for`
 * is a fallback for other hosts (the VM deployment behind a reverse proxy); its
 * first entry is the original client. Neither is treated as an identity — this
 * value only ever forms part of a rate-limit key.
 *
 * Pure and dependency-free so it can be unit-tested with any object that has
 * `get()`; the Next.js `headers()` result satisfies that shape.
 */
export function clientIpFromHeaders(h: Headers | { get(name: string): string | null }): string {
  const netlify = h.get('x-nf-client-connection-ip');
  if (netlify && netlify.trim()) return netlify.trim();

  // `x-forwarded-for` is client-supplied unless something in front of the app
  // overwrites it, so trusting it is only safe behind a proxy that does. On
  // Netlify the question does not arise: `x-nf-client-connection-ip` above is
  // set from the real TCP peer and always wins, so a caller who adds their own
  // XFF header changes nothing. On the VM shape this fallback is only as
  // trustworthy as the reverse proxy in front of it — a caller who can reach
  // the app directly, bypassing that proxy, can rotate this header freely and
  // evade the per-IP limit (the per-address email limit is the backstop there).
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  // One shared, fail-closed bucket for every caller carrying neither header:
  // they all key to `unknown` and consume the same counter. Fail-closed is the
  // deliberate choice — an unattributable caller is throttled rather than
  // waved through — but it also means a proxy misconfiguration that strips
  // both headers collapses all legitimate traffic into a single limit.
  return 'unknown';
}
