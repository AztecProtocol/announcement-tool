import type { Sql } from 'postgres';
import { checksApply, guardEnvFromProcess, type GuardEnv } from './production-guard.js';
import { AUTH0_IDENTITY_HEADER } from './auth0-claims.js';

export interface Identity { email: string; name?: string; source: 'auth0' | 'tailscale' | 'dev' }

/**
 * Resolves who is making this request, from one of three sources in strict
 * precedence order: verified Auth0 (Netlify), Tailscale (VM), then a dev fallback.
 *
 * ── Why the Auth0 header can be trusted ──────────────────────────────────────
 * `AUTH0_IDENTITY_HEADER` is a plain, unsigned header. Read on its own it proves
 * nothing, and anyone able to send a request straight to the origin can set it.
 * It is trustworthy under exactly one condition:
 *
 *     middleware.ts (repository root) deletes any inbound copy of this header
 *     unconditionally, as its very first action, and re-sets it only after
 *     fully verifying an RS256 Auth0 JWT — signature, issuer, audience, expiry
 *     — and confirming a verified email claim.
 *
 * If that strip is ever removed, made conditional, or moved after an early
 * return, this function starts returning attacker-chosen identities. That breaks
 * the four-eyes rule on `critical` announcements, whose whole job is to stop one
 * person self-approving an irreversible Discord role ping. Do not read this
 * header anywhere else, and do not relax middleware.ts's matcher without
 * re-checking every route that calls this.
 *
 * ── Why the Tailscale header can be trusted, and only on the VM ─────────────
 * Identity comes from Tailscale's proxy headers, which are injected by
 * `tailscale serve`. That is sound for exactly one deployment shape: the app
 * binds to loopback and `tailscale serve` is the sole route in, so nothing
 * client-supplied can reach the origin. This path stays live because
 * `DEPLOY_TARGET=vm` deploys to a VM, and removing it would strand that
 * deployment.
 *
 * It is not sound anywhere else. On Netlify there is no such proxy: requests
 * arrive from the public internet and Netlify strips only its own `X-Nf-*`
 * headers, so `Tailscale-User-Login` there can only be attacker-supplied. If
 * this header were trusted on Netlify, anyone could name themselves an existing
 * publisher, request a `critical` announcement as one address and confirm it as
 * another — collapsing four-eyes to one person and firing an irreversible
 * Discord role ping.
 *
 * So the two identity sources are mutually exclusive per deployment, decided by
 * the same explicit `DEPLOY_TARGET` signal production-guard.ts uses. The gate is
 * an allowlist — the Tailscale branch runs when DEPLOY_TARGET is exactly 'vm'
 * and at no other time. Unset, misspelled, or any future value therefore
 * disables it rather than enabling it: a wrong value must lose the identity
 * source, never gain one. Nothing legitimate is stranded by that default,
 * because production-guard.ts already refuses to boot on an unset or
 * unrecognized DEPLOY_TARGET, and local development resolves identity through
 * the ADMIN_EMAIL fallback below rather than through Tailscale headers.
 *
 * middleware.ts also deletes both Tailscale headers on the admin routes it
 * matches. That is defence in depth, not the fix — this gate is the fix, and it
 * covers every caller regardless of the middleware matcher.
 *
 * Read directly from process.env rather than taken as a parameter: this
 * function is synchronous and has 17 call sites of the form
 * `resolveIdentity(await headers())`, and an extra parameter would have to be
 * threaded correctly through every one of them — a gate you can forget to pass
 * is a gate that will be forgotten.
 */
export function resolveIdentity(headers: Headers, opts: { devEmail?: string } = {}): Identity | undefined {
  // One normalisation boundary for every identity source: isPublisher and the
  // four-eyes checks already compare case-insensitively, but resolving to a
  // consistently-cased identity here means every caller of resolveIdentity
  // (17 call sites) sees the same value for "this person" regardless of which
  // source produced it, rather than depending on each downstream comparison
  // to remember to normalise. emailFromClaims already lowercases the Auth0
  // claim before it reaches this header, so this is defence in depth there,
  // and the only normalisation for the Tailscale and dev-fallback sources.
  const auth0Email = headers.get(AUTH0_IDENTITY_HEADER);
  if (auth0Email) {
    const trimmed = auth0Email.trim().toLowerCase();
    if (trimmed) return { email: trimmed, source: 'auth0' };
  }

  // Allowlist, not a denylist: only the VM shape trusts Tailscale headers.
  if (process.env.DEPLOY_TARGET === 'vm') {
    const tsUser = headers.get('Tailscale-User-Login');
    if (tsUser) {
      const name = headers.get('Tailscale-User-Name') ?? undefined;
      return { email: tsUser.trim().toLowerCase(), ...(name ? { name } : {}), source: 'tailscale' };
    }
  }
  const dev = opts.devEmail ?? process.env.ADMIN_EMAIL;
  return dev ? { email: dev.trim().toLowerCase(), source: 'dev' } : undefined;
}

export async function listPublishers(sql: Sql): Promise<string[]> {
  const rows = await sql`select email from publishers order by email`;
  return rows.map(r => r.email as string);
}

/**
 * Whether this email may publish.
 *
 * An empty table is a fresh install. In insecure local development that
 * means "allow anyone", so the first admin is not locked out. On a deployed
 * instance it means "allow nobody": the table can become empty long after
 * the start check ran, and a function instance lives for hours.
 */
export async function isPublisher(sql: Sql, email: string, env: GuardEnv = guardEnvFromProcess()): Promise<boolean> {
  const [{ c }] = await sql`select count(*)::int as c from publishers`;
  if (c === 0) return !checksApply(env);
  const rows = await sql`select 1 from publishers where lower(email) = lower(${email})`;
  return rows.length > 0;
}

const UNREACHABLE = new Set(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', '57P03', '53300']);

export type StartCheckResult = 'ok' | 'unreachable';

/**
 * The start check: refuse to start a deployed instance whose publishers table
 * is empty.
 *
 * It is an early, loud signal, not the guarantee. The guarantee is
 * isPublisher above, which refuses an empty table on every request. That is
 * why a database that cannot be reached here is NOT fatal: Next stores a
 * failed start for the life of the function instance, so one connect timeout
 * during a cold start answered 500 on every page until a redeploy
 * (2026-10-08, about 50 minutes). An unreachable database is logged and the
 * instance starts; requests then succeed or fail on their own merits. A
 * reachable-and-empty table, and any misconfiguration (bad password,
 * certificate, missing table), still throw.
 */
export async function assertPublishersConfigured(
  sql: Sql, env: GuardEnv, opts: { budgetMs?: number } = {},
): Promise<StartCheckResult> {
  if (!checksApply(env)) return 'ok';
  const budgetMs = opts.budgetMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const query = (async () => (await sql`select count(*)::int as c from publishers`) as unknown as Array<{ c: number }>)();
  // If the budget wins the race, the query is still in flight; its eventual
  // rejection must not surface as an unhandled rejection.
  // An error that arrives late is still worth seeing (it may be a
  // misconfiguration, not a slow network), so it is logged. An error inside
  // the budget is reported by the awaited race below, not here.
  let budgetFired = false;
  query.catch((err: unknown) => {
    if (!budgetFired) return;
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`start check: the database answered late with an error (${typeof code === 'string' ? code : 'no code'})`);
  });
  const budget = new Promise<'budget'>(resolve => { timer = setTimeout(() => resolve('budget'), budgetMs); });
  let rows: Array<{ c: number }> | 'budget';
  try {
    rows = await Promise.race([query, budget]);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && UNREACHABLE.has(code)) {
      console.error(`start check: database unreachable (${code}); starting anyway — publishers are checked on every request`);
      return 'unreachable';
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (rows === 'budget') {
    budgetFired = true;
    console.error(`start check: database unreachable (no answer in ${budgetMs} ms); starting anyway — publishers are checked on every request`);
    return 'unreachable';
  }
  const c = rows[0]?.c;
  if (c === 0) {
    throw new Error(
      'Refusing to start: the publishers table is empty, which would let anyone '
      + 'reaching the admin publish. Add the first publisher with: npm run seed:publisher -- you@example.com',
    );
  }
  // A malformed answer must not count as "ok".
  if (typeof c !== 'number' || !(c > 0)) throw new Error('start check: unexpected answer from the publishers count query');
  return 'ok';
}
