import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { requirePublisher } from '../src/web/admin-gate.js';
import { AUTH0_IDENTITY_HEADER } from '../src/core/auth0-claims.js';

// The suite runs with ANNOUNCE_ALLOW_INSECURE_DEV and ADMIN_EMAIL unset, so
// the deployed rule applies: an empty publishers table authorises nobody, and
// there is no dev fallback identity.
let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); await sql`delete from publishers`; });
afterAll(async () => { await sql.end(); });

const as = (email: string) => new Headers({ [AUTH0_IDENTITY_HEADER]: email });

describe('requirePublisher (the admin read gate)', () => {
  it('no identity header → no-identity, and the publishers table is not queried', async () => {
    const spy = vi.fn(() => { throw new Error('the database must not be queried'); });
    const stub = ((..._a: unknown[]) => spy()) as unknown as Sql;
    expect(await requirePublisher(stub, new Headers())).toEqual({ ok: false, reason: 'no-identity' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an identity that is not a publisher → not-publisher', async () => {
    await sql`insert into publishers (email) values ('pub@example.com')`;
    expect(await requirePublisher(sql, as('other@example.com'))).toEqual({ ok: false, reason: 'not-publisher' });
  });

  it('a publisher, any letter case → ok with the identity and the list', async () => {
    await sql`insert into publishers (email) values ('pub@example.com'), ('second@example.com')`;
    expect(await requirePublisher(sql, as('PUB@Example.com'))).toEqual({
      ok: true,
      identity: { email: 'pub@example.com', source: 'auth0' },
      publishers: ['pub@example.com', 'second@example.com'],
    });
  });

  it('an empty publishers table → not-publisher (deployed rule)', async () => {
    expect(await requirePublisher(sql, as('pub@example.com'))).toEqual({ ok: false, reason: 'not-publisher' });
  });

  it('a database error → unavailable, and it does not throw', async () => {
    const rejecting = ((..._a: unknown[]) => Promise.reject(new Error('connection refused'))) as unknown as Sql;
    expect(await requirePublisher(rejecting, as('pub@example.com'))).toEqual({ ok: false, reason: 'unavailable' });
  });
});
