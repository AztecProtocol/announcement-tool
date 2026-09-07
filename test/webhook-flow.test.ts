import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { registerWebhook, ENDPOINT_NOT_VERIFIED } from '../src/core/webhook-flow.js';
import { createSubscription } from '../src/core/subscriptions.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}/hook` });
    });
  });
}

const publicLookup = async () => [{ address: '203.0.113.10', family: 4 as const }];

describe('registerWebhook', () => {
  it('creates the sub, sends a verifiable signed test event, marks verified on 2xx', async () => {
    let seen: { body: string; headers: Record<string, string | string[] | undefined> } | undefined;
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { seen = { body: d, headers: req.headers }; res.writeHead(200); res.end(); });
    });
    const res = await registerWebhook(sql, { url, allowPrivateHosts: true });
    server.close();

    expect(res.verified).toBe(true);
    expect(res.secretOnce).toMatch(/^whsec_/);
    expect(res.unsubscribeUrl).toMatch(/^https:\/\/announce\.aztec\.network\/u\/[0-9a-f]{32}$/);
    const payload = JSON.parse(seen!.body);
    expect(payload.kind).toBe('test');
    expect(payload.event_id).toMatch(/^whtest_sub_/);
    const ts = seen!.headers['x-announce-timestamp'] as string;
    const sig = (seen!.headers['x-announce-signature'] as string).replace('v1=', '');
    expect(sig).toBe(createHmac('sha256', res.secretOnce!).update(`${ts}.${seen!.body}`).digest('hex'));
    const [row] = await sql`select verified from subscriptions where endpoint = ${url}`;
    expect(row.verified).toBe(true);
  });

  it('endpoint failing the test event stays unverified with the generic message', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(500); res.end(); });
    const res = await registerWebhook(sql, { url, allowPrivateHosts: true });
    server.close();
    expect(res.verified).toBe(false);
    expect(res.error).toBe(ENDPOINT_NOT_VERIFIED);
    expect(res.error).not.toContain('500');
    const [row] = await sql`select verified from subscriptions where endpoint = ${url}`;
    expect(row.verified).toBe(false);
  });

  // H-2: the upstream status, exception text, and resolved address are an
  // oracle — they'd let an anonymous caller turn this blind server-side
  // request into a port scan of whatever the URL pointed at. Every failure
  // mode of the verification request must collapse to one opaque constant.
  describe('verification failure never leaks upstream detail (H-2)', () => {
    it('a non-2xx status collapses to the generic message', async () => {
      const { server, url } = await listen((_req, res) => { res.writeHead(503); res.end(); });
      const res = await registerWebhook(sql, { url, allowPrivateHosts: true });
      server.close();
      expect(res).toMatchObject({ verified: false, error: ENDPOINT_NOT_VERIFIED });
      expect(res.error).not.toContain('503');
    });

    it('a connection-refused exception collapses to the generic message', async () => {
      const fetchImpl: typeof fetch = async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      };
      const res = await registerWebhook(sql, {
        url: 'https://never-registered-2.example.com/h', lookup: publicLookup, fetchImpl,
      });
      expect(res).toMatchObject({ verified: false, error: ENDPOINT_NOT_VERIFIED });
      expect(res.error).not.toContain('ECONNREFUSED');
      expect(res.error).not.toContain('10.0.0.5');
    });

    it('a timeout exception collapses to the generic message', async () => {
      class TimeoutError extends Error {
        constructor() { super('The operation was aborted due to timeout'); this.name = 'TimeoutError'; }
      }
      const fetchImpl: typeof fetch = async () => { throw new TimeoutError(); };
      const res = await registerWebhook(sql, {
        url: 'https://never-registered-3.example.com/h', lookup: publicLookup, fetchImpl,
      });
      expect(res).toMatchObject({ verified: false, error: ENDPOINT_NOT_VERIFIED });
      expect(res.error).not.toContain('Timeout');
    });
  });

  it('re-registering with the correct secret updates filters, keeps the secret, does not return it again', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(200); res.end(); });
    const first = await registerWebhook(sql, { url, allowPrivateHosts: true });
    const again = await registerWebhook(sql, {
      url, secret: first.secretOnce, filters: { severities: ['critical'] }, allowPrivateHosts: true,
    });
    server.close();
    expect(again.secretOnce).toBeUndefined();
    expect(again.unsubscribeUrl).toBeUndefined();
    expect(again.verified).toBe(true);
    const [row] = await sql`select secret, filter_severities from subscriptions where endpoint = ${url}`;
    expect(`whsec_${''}`.length).toBeGreaterThan(0); // structure guard
    expect(row.secret).toBe(first.secretOnce);
    expect(row.filter_severities).toEqual(['critical']);
  });

  it('rejects a non-https public url without touching the database', async () => {
    const res = await registerWebhook(sql, { url: 'http://example.com/hook' });
    expect(res.verified).toBe(false);
    // Refusals answer with one opaque constant. The old message named the
    // scheme and the host, which let an anonymous caller probe the network.
    expect(res.error).toBe('webhook url not allowed');
    expect(res.error).not.toMatch(/example\.com/);
    const [{ c }] = await sql`select count(*)::int as c from subscriptions`;
    expect(c).toBe(0);
  });

  // Regression test for the same select-then-insert race documented in
  // subscribe-flow.test.ts: two near-simultaneous first-time registrations for the
  // same endpoint can both pass the initial "does a row exist?" select, so the
  // second call's createSubscription insert loses to the unique (channel, endpoint)
  // constraint and must not surface a raw Postgres 23505 unique-violation. Unlike a
  // pre-create-then-call approach (which only exercises the ordinary existing-row
  // branch, since the leading select would find the row directly), this test uses
  // dependency injection to force execution down the actual catch(23505) path:
  // registerWebhook's `createSubscriptionImpl` override first calls the real
  // createSubscription (so the row actually gets created — simulating the
  // concurrent winner committing first) and then throws a Postgres-shaped 23505
  // error, so registerWebhook's own insert branch truly hits the catch block,
  // re-selects the row, and falls through to applyFilters — proving that exact
  // code path never throws and never re-exposes the secret.
  it('does not throw when the insert loses the unique-violation race (23505 catch path)', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(200); res.end(); });

    let realSub: { id: string; secret?: string } | undefined;
    const raceCreate: typeof createSubscription = async (sql2, input2) => {
      const sub = await createSubscription(sql2, input2);
      realSub = sub;
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    };

    const res = await registerWebhook(sql, {
      url, filters: { severities: ['critical'] }, allowPrivateHosts: true,
      createSubscriptionImpl: raceCreate,
    });
    server.close();

    expect(res.secretOnce).toBeUndefined();
    expect(res.verified).toBe(true);
    const [row] = await sql`select id, secret, filter_severities, verified from subscriptions where endpoint = ${url}`;
    expect(row.id).toBe(realSub!.id);
    expect(row.secret).toBe(realSub!.secret);
    expect(row.filter_severities).toEqual(['critical']);
    expect(row.verified).toBe(true);
  });

  it('fresh registration with an empty filter array returns an error without creating a row', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(200); res.end(); });
    const res = await registerWebhook(sql, { url, filters: { severities: [] }, allowPrivateHosts: true });
    server.close();
    expect(res.verified).toBe(false);
    expect(res.error).toContain('severities');
    expect(res.secretOnce).toBeUndefined();
    const [{ c }] = await sql`select count(*)::int as c from subscriptions`;
    expect(c).toBe(0);
  });

  it('re-registration without the secret is refused with a generic message', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(200); res.end(); });
    await registerWebhook(sql, { url, allowPrivateHosts: true });
    const res = await registerWebhook(sql, { url, filters: { severities: ['critical'] }, allowPrivateHosts: true });
    server.close();
    expect(res.verified).toBe(false);
    expect(res.error).toBe('not authorized or not registered');
    const [row] = await sql`select filter_severities from subscriptions where endpoint = ${url}`;
    expect(row.filter_severities).toEqual(['critical', 'recommended', 'info']); // unchanged
  });

  it('re-registration with the correct secret updates filters', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(200); res.end(); });
    const first = await registerWebhook(sql, { url, allowPrivateHosts: true });
    const res = await registerWebhook(sql, {
      url, secret: first.secretOnce, filters: { severities: ['critical'] }, allowPrivateHosts: true,
    });
    server.close();
    expect(res.verified).toBe(true);
    expect(res.secretOnce).toBeUndefined();
    const [row] = await sql`select filter_severities from subscriptions where endpoint = ${url}`;
    expect(row.filter_severities).toEqual(['critical']);
  });

  it('an unregistered url with a wrong secret answers identically — no existence oracle', async () => {
    const a = await registerWebhook(sql, {
      url: 'https://never-registered.example.com/h', secret: 'whsec_wrong', lookup: publicLookup,
    });
    expect(a.error).toBe('not authorized or not registered');
  });

  it('refuses a public name that resolves to a private address, without contacting it', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => { called = true; return new Response('', { status: 200 }); };
    const res = await registerWebhook(sql, {
      url: 'https://rebind.attacker.example/h',
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
      fetchImpl,
    });
    expect(res).toEqual({ verified: false, error: 'webhook url not allowed' });
    expect(called).toBe(false);
    const rows = await sql`select id from subscriptions where endpoint = 'https://rebind.attacker.example/h'`;
    expect(rows.length).toBe(0);
  });
});
