/**
 * Claim extraction for Auth0-issued JWTs.
 *
 * This module is deliberately PURE and network-free. It takes a payload that has
 * ALREADY had its signature, issuer, audience and expiry verified (that happens in
 * middleware.ts via `jose`), and decides whether the claims describe an identity we
 * are willing to treat as a publisher.
 *
 * Splitting it out this way is what makes the security-relevant branching testable
 * without an Auth0 tenant: the cryptography is jose's problem, the policy is here.
 */

/** Auth0 marks addresses it has actually confirmed with `email_verified`. */
const EMAIL_VERIFIED_CLAIM = 'email_verified';
const EMAIL_CLAIM = 'email';

/**
 * Returns the email to use as the caller's identity, or undefined to deny.
 *
 * Fails closed on every unexpected shape. In particular `email_verified` must be
 * exactly boolean `true` — a missing claim, a string "true", or `false` all deny.
 * Without that check, anyone who can register an account at an address they do not
 * own becomes a valid SECOND approver for a `critical` announcement, which defeats
 * the four-eyes rule protecting the irreversible Discord role ping.
 */
export function emailFromClaims(payload: Record<string, unknown>): string | undefined {
  if (payload[EMAIL_VERIFIED_CLAIM] !== true) return undefined;

  const email = payload[EMAIL_CLAIM];
  if (typeof email !== 'string') return undefined;

  // Whitespace-only would otherwise become a truthy identity that matches nothing
  // useful but still satisfies "an identity resolved".
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The internal request header that middleware.ts sets to the verified email.
 *
 * Named with an `x-announce-internal-` prefix so it is obviously not a platform
 * header and obviously not something a client should ever send. It carries no
 * signature of its own — see resolveIdentity's doc comment and middleware.ts for
 * the (single, load-bearing) reason it can be trusted.
 */
export const AUTH0_IDENTITY_HEADER = 'x-announce-internal-auth0-email';
