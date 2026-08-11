import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { startEmailSubscription, confirmSubscription } from '../src/core/subscribe-flow.js';
import { getSubscription, createSubscription } from '../src/core/subscriptions.js';
import type { EmailMessage, EmailSender } from '../src/adapters/esp.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

function recorder(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, sender: { name: 'test', async send(m) { sent.push(m); } } };
}

describe('email double-opt-in', () => {
  it('new address: creates unverified sub and sends a confirmation link', async () => {
    const { sender, sent } = recorder();
    const res = await startEmailSubscription(sql, sender, {
      email: 'new@example.com', filters: { severities: ['critical'] }, baseUrl: 'https://announce.example',
    });
    expect(res).toBe('confirmation_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('new@example.com');
    const m = sent[0].text.match(/https:\/\/announce\.example\/confirm\/([0-9a-f]{32})/);
    expect(m).not.toBeNull();

    const confirmed = await confirmSubscription(sql, m![1]);
    expect(confirmed?.endpoint).toBe('new@example.com');
    expect((await getSubscription(sql, confirmed!.id))!.verified).toBe(true);
  });

  it('re-subscribing an unverified address updates filters and re-sends confirmation', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'p@example.com' });
    const res = await startEmailSubscription(sql, sender, { email: 'p@example.com', filters: { severities: ['critical'] } });
    expect(res).toBe('confirmation_sent');
    expect(sent).toHaveLength(2);
    const [row] = await sql`select filter_severities, verified from subscriptions where endpoint = 'p@example.com'`;
    expect(row.filter_severities).toEqual(['critical']);
    expect(row.verified).toBe(false);
  });

  it('re-subscribing a verified address updates filters, sends a notice, stays verified', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'v@example.com' });
    const token = sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1];
    await confirmSubscription(sql, token);

    const res = await startEmailSubscription(sql, sender, { email: 'v@example.com', filters: { networks: ['mainnet'] } });
    expect(res).toBe('updated');
    expect(sent).toHaveLength(2);
    expect(sent[1].subject.toLowerCase()).toContain('updated');
    const [row] = await sql`select filter_networks, verified from subscriptions where endpoint = 'v@example.com'`;
    expect(row.filter_networks).toEqual(['mainnet']);
    expect(row.verified).toBe(true);
  });

  it('confirming an unknown token returns undefined', async () => {
    expect(await confirmSubscription(sql, 'a'.repeat(32))).toBeUndefined();
  });

  // Regression test for a select-then-insert race: two near-simultaneous first-time
  // subscribes for the same email can both pass startEmailSubscription's initial
  // "does a row exist?" select, so the second call's insert loses to the unique
  // (channel, endpoint) constraint and would previously throw a raw Postgres
  // unique-violation. A true concurrent race (two separate requests interleaving at
  // the database level) is not reliably reproducible from a single test process —
  // a `Promise.all` of two `startEmailSubscription` calls was tried and empirically
  // did NOT trigger the catch(23505) path in repeated runs (postgres.js appears to
  // serialize the pooled queries such that the second call's select already sees the
  // first call's committed insert, so it never reaches its own insert). So this test
  // takes the honest, deterministic route instead: pre-create the row directly via
  // createSubscription (bypassing the flow's own initial select, standing in for
  // "another request already committed this insert"), then call
  // startEmailSubscription for the same email and assert it does not throw and
  // produces the same result the catch-and-fallback path is required to produce
  // (filters updated, confirmation re-sent, still unverified). This proves the
  // fallback *logic* (updateExistingAndNotify) is correct and reachable-without-throw
  // for "row already exists"; it does not exercise the catch(23505) branch's own code
  // path specifically, since here the leading select finds the row directly. The two
  // code paths (leading-select-hit vs. catch-then-fallback) call the exact same
  // updateExistingAndNotify function, so this test does cover the fallback behavior
  // both paths rely on, even though it cannot force the race timing itself.
  it('does not throw when the row already exists at insert time (existing-row branch)', async () => {
    const { sender, sent } = recorder();
    await createSubscription(sql, { channel: 'email', endpoint: 'race@example.com' });

    const res = await startEmailSubscription(sql, sender, {
      email: 'race@example.com', filters: { severities: ['critical'] },
    });

    expect(res).toBe('confirmation_sent');
    expect(sent).toHaveLength(1);
    const [row] = await sql`select filter_severities, verified from subscriptions where endpoint = 'race@example.com'`;
    expect(row.filter_severities).toEqual(['critical']);
    expect(row.verified).toBe(false);
  });

  // Regression test for the same select-then-insert race documented above, but this
  // one actually exercises the catch(23505) path directly (mirroring
  // webhook-flow.test.ts's equivalent test), rather than only covering the
  // fallback logic via a pre-created row. startEmailSubscription's
  // `createSubscriptionImpl` override first calls the real createSubscription (so
  // the row genuinely gets created — simulating the concurrent winner committing
  // first) and then throws a Postgres-shaped 23505 error, so startEmailSubscription's
  // own insert branch truly hits the catch block, re-selects the row, and falls
  // through to updateExistingAndNotify — proving that exact code path never throws
  // and sends exactly one confirmation email to the pre-existing row's token.
  it('does not throw when the insert loses the unique-violation race (23505 catch path)', async () => {
    const { sender, sent } = recorder();

    let realSub: { id: string; verifyToken: string } | undefined;
    const raceCreate: typeof createSubscription = async (sql2, input2) => {
      const sub = await createSubscription(sql2, input2);
      realSub = sub;
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    };

    const res = await startEmailSubscription(sql, sender, {
      email: 'race2@example.com', filters: { severities: ['critical'] },
      createSubscriptionImpl: raceCreate,
    });

    expect(res).toBe('confirmation_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('race2@example.com');
    expect(sent[0].text).toContain(`/confirm/${realSub!.verifyToken}`);
    const [row] = await sql`select id, filter_severities, verified from subscriptions where endpoint = 'race2@example.com'`;
    expect(row.id).toBe(realSub!.id);
    expect(row.filter_severities).toEqual(['critical']);
    expect(row.verified).toBe(false);
  });
});
