/**
 * The origin the public site is served from, used to build absolute links:
 * canonical announcement URLs, feed entries, confirmation and unsubscribe
 * links, and the Auth0 callback URL.
 *
 * Resolution order: an explicit override (callers that carry a base URL in
 * their options), then `PUBLIC_BASE_URL`, then the production host. A
 * deployed instance never reaches the default — the production checks
 * refuse to start without `PUBLIC_BASE_URL` (see README, "Production
 * checks") — so the default exists for local tooling and tests. It is the
 * real host so that a missing variable in development still produces links
 * that point somewhere true.
 *
 * Trailing slashes are stripped so callers can append `/a/<slug>` without
 * producing `//`.
 */
export const DEFAULT_PUBLIC_BASE_URL = 'https://announce.aztec.network';

export function publicBaseUrl(override?: string): string {
  return (override ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}
