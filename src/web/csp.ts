/**
 * The Content Security Policy, built per request around a nonce.
 *
 * Why a nonce: Next.js emits inline scripts on every page, so a policy that
 * bans inline script outright breaks the site. A nonce is a random value
 * generated per request; the policy says "inline scripts are allowed only if
 * they carry this exact value", the middleware puts it on the request so Next
 * stamps it onto the scripts it emits, and any script an attacker manages to
 * inject into rendered content does not carry it and does not run. That is
 * the containment the 2026-09-11 attribute-injection finding lacked.
 *
 * Why 'strict-dynamic': a nonce'd script may load further scripts; Next's
 * runtime does this. Without it every chunk would need its own nonce.
 *
 * Why style-src keeps 'unsafe-inline': the app and the rendered announcement
 * HTML use inline style attributes (`style="margin:..."`), which a nonce cannot
 * cover, and inline styles are not the script-execution vector this policy
 * addresses. Tightening styles is a separate change.
 *
 * Mode: the response header name is chosen by CSP_MODE. Anything other than
 * the exact string 'enforce' selects Report-Only, where the browser reports
 * what it would block and blocks nothing. That is the safe default: it lets
 * the policy ship to the live site and be read before it is enforced, and it
 * is the rollback — unset the variable and redeploy.
 *
 * Nonce generation uses the Web Crypto global (`crypto.getRandomValues`), not
 * `node:crypto`, because this module is imported by middleware.ts, and Next.js
 * middleware always runs in the edge runtime, which does not carry Node's
 * `crypto` module (only a documented subset of Node APIs is available there).
 * `crypto.getRandomValues` and `btoa` are both standard Web Platform globals
 * present in the edge runtime, in Node, and in browsers, so this same code path
 * works everywhere the module is imported from.
 */
export const REPORT_PATH = '/api/csp-report';

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
    `report-uri ${REPORT_PATH}`,
  ].join('; ');
}

export function cspHeaderName(mode: string | undefined): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
}
