import type { Sql } from 'postgres';
import { resolveIdentity, isPublisher, listPublishers, type Identity } from '../core/identity.js';

export type AdminGate =
  | { ok: true; identity: Identity; publishers: string[] }
  | { ok: false; reason: 'no-identity' | 'not-publisher' | 'unavailable' };

/**
 * Who may READ the admin area.
 *
 * Every admin page calls this first, and so does the layout. The layout alone
 * is not enough: Next renders the page segment even when the layout does not
 * return `children`. The page's own queries then run for anyone, and Next
 * ships the page payload in the response, where the browser does not show it
 * but anyone can read it. That holds for every GET of an admin page: the
 * inline flight data of an ordinary HTML response, a full `RSC: 1` response,
 * and a partial-render response. Until 2026-10-08 each of those returned the
 * page data to a request with no session.
 *
 * Never throws. Any failure to verify is a refusal.
 */
export async function requirePublisher(sql: Sql, headers: Headers): Promise<AdminGate> {
  const identity = resolveIdentity(headers);
  if (!identity) return { ok: false, reason: 'no-identity' };
  try {
    const allowed = await isPublisher(sql, identity.email);
    if (!allowed) return { ok: false, reason: 'not-publisher' };
    return { ok: true, identity, publishers: await listPublishers(sql) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
