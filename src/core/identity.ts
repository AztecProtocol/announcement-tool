import type { Sql } from 'postgres';
import { checksApply, type GuardEnv } from './production-guard.js';

export interface Identity { email: string; name?: string; source: 'tailscale' | 'dev' }

/**
 * Identity comes from Tailscale's proxy headers. This is only sound because the
 * app binds to localhost and `tailscale serve` is the sole route in — if the port
 * were publicly exposed, the header could be forged. See concept doc §8.
 */
export function resolveIdentity(headers: Headers, opts: { devEmail?: string } = {}): Identity | undefined {
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
 * Refuses to start in production with no publishers configured.
 *
 * isPublisher's bootstrap rule (empty table = anyone may publish) keeps a fresh
 * local install usable. In production that same rule means one truncated table
 * is an open publish endpoint on five channels, so this assertion runs at
 * startup instead. Deliberately NOT folded into isPublisher: that runs per
 * request, and a policy branch there would put the permissive path one bug away
 * from being reachable in production.
 */
export async function assertPublishersConfigured(sql: Sql, env: GuardEnv): Promise<void> {
  if (!checksApply(env)) return;
  const [{ c }] = await sql`select count(*)::int as c from publishers`;
  if (c === 0) {
    throw new Error(
      'Refusing to start: the publishers table is empty in production, which would let anyone '
      + 'reaching the admin publish. Add the first publisher with: npm run seed:publisher -- you@example.com',
    );
  }
}
