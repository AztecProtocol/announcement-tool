import type { Sql } from 'postgres';

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
