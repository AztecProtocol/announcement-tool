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

  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}
