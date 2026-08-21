import type { Sql } from 'postgres';
import { checksApply, type GuardEnv } from './production-guard.js';
import { AUTH0_IDENTITY_HEADER } from './auth0-claims.js';

export interface Identity { email: string; name?: string; source: 'auth0' | 'tailscale' | 'dev' }

/**
 * Resolves who is making this request, from one of three sources in strict
 * precedence order: verified Auth0 (Netlify), Tailscale (VM), then a dev fallback.
 *
 * ── Why the Auth0 header can be trusted ──────────────────────────────────────
 * `AUTH0_IDENTITY_HEADER` is a PLAIN, UNSIGNED header. Read on its own it proves
 * nothing, and anyone able to send a request straight to the origin can set it.
 * It is trustworthy under exactly one condition:
 *
 *     middleware.ts (repository root) DELETES any inbound copy of this header
 *     unconditionally, as its very first action, and re-sets it ONLY after
 *     fully verifying an RS256 Auth0 JWT — signature, issuer, audience, expiry
 *     — and confirming a verified email claim.
 *
 * If that strip is ever removed, made conditional, or moved after an early
 * return, this function starts returning attacker-chosen identities. That breaks
 * the four-eyes rule on `critical` announcements, whose whole job is to stop one
 * person self-approving an IRREVERSIBLE Discord role ping. Do not read this
 * header anywhere else, and do not relax middleware.ts's matcher without
 * re-checking every route that calls this.
 *
 * ── Why the Tailscale header can be trusted ──────────────────────────────────
 * Identity comes from Tailscale's proxy headers. This is only sound because the
 * app binds to localhost and `tailscale serve` is the sole route in — if the port
 * were publicly exposed, the header could be forged. See concept doc §8. This
 * path is still live: `main` deploys to a VM, so removing it would strand that
 * deployment.
 */
export function resolveIdentity(headers: Headers, opts: { devEmail?: string } = {}): Identity | undefined {
  const auth0Email = headers.get(AUTH0_IDENTITY_HEADER);
  if (auth0Email) {
    const trimmed = auth0Email.trim();
    if (trimmed) return { email: trimmed, source: 'auth0' };
  }

  const tsUser = headers.get('Tailscale-User-Login');
  if (tsUser) {
    const name = headers.get('Tailscale-User-Name') ?? undefined;
    return { email: tsUser, ...(name ? { name } : {}), source: 'tailscale' };
  }
  const dev = opts.devEmail ?? process.env.ADMIN_EMAIL;
  return dev ? { email: dev, source: 'dev' } : undefined;
}

export async function listPublishers(sql: Sql): Promise<string[]> {
  const rows = await sql`select email from publishers order by email`;
  return rows.map(r => r.email as string);
}

/** Empty table = fresh install; allow anyone so the first admin isn't locked out. */
export async function isPublisher(sql: Sql, email: string): Promise<boolean> {
  const [{ c }] = await sql`select count(*)::int as c from publishers`;
  if (c === 0) return true;
  const rows = await sql`select 1 from publishers where email = ${email}`;
  return rows.length > 0;
}

/**
 * Refuses to start with no publishers configured.
 *
 * isPublisher's bootstrap rule (empty table = anyone may publish) keeps a fresh
 * local install usable. In production that same rule means one truncated table
 * is an open publish endpoint on five channels, so this assertion runs at
 * startup instead. Deliberately NOT folded into isPublisher: that runs per
 * request, and a policy branch there would put the permissive path one bug away
 * from being reachable on a deployed instance.
 */
export async function assertPublishersConfigured(sql: Sql, env: GuardEnv): Promise<void> {
  if (!checksApply(env)) return;
  const [{ c }] = await sql`select count(*)::int as c from publishers`;
  if (c === 0) {
    throw new Error(
      'Refusing to start: the publishers table is empty, which would let anyone '
      + 'reaching the admin publish. Add the first publisher with: npm run seed:publisher -- you@example.com',
    );
  }
}
