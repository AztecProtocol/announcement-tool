import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { startEmailSubscription, confirmSubscription, confirmFilterChange } from '../src/core/subscribe-flow.js';
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

  it('re-subscribing an unverified address issues a new token with a fresh issued_at', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'refresh@example.com' });
    const firstToken = sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1];
    const [before] = await sql`select verify_token, verify_token_issued_at from subscriptions where endpoint = 'refresh@example.com'`;

    // Backdate the issued_at so a real time gap between "before" and the re-subscribe is provable.
    await sql`update subscriptions set verify_token_issued_at = now() - interval '1 hour' where endpoint = 'refresh@example.com'`;

    await startEmailSubscription(sql, sender, { email: 'refresh@example.com' });
    const secondToken = sent[1].text.match(/\/confirm\/([0-9a-f]{32})/)![1];
    const [after] = await sql`select verify_token, verify_token_issued_at from subscriptions where endpoint = 'refresh@example.com'`;

    expect(secondToken).not.toBe(firstToken);
    expect(after.verify_token).toBe(secondToken);
    expect(before.verify_token).not.toBe(after.verify_token);
    expect(new Date(after.verify_token_issued_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('re-subscribing a verified address with no filter change sends an update notice, stays verified', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'v@example.com' });
    const token = sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1];
    await confirmSubscription(sql, token);

    const res = await startEmailSubscription(sql, sender, { email: 'v@example.com' });
    expect(res).toBe('updated');
    expect(sent).toHaveLength(2);
    expect(sent[1].subject.toLowerCase()).toContain('updated');
    const [row] = await sql`select verified from subscriptions where endpoint = 'v@example.com'`;
    expect(row.verified).toBe(true);
  });

  it('re-subscribing a verified address with a filter change does not apply it until confirmed', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'v2@example.com' });
    const token = sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1];
    await confirmSubscription(sql, token);

    const res = await startEmailSubscription(sql, sender, { email: 'v2@example.com', filters: { networks: ['mainnet'] } });
    expect(res).toBe('change_pending');
    expect(sent).toHaveLength(2);
    const [row] = await sql`select filter_networks, verified from subscriptions where endpoint = 'v2@example.com'`;
    expect(row.filter_networks).toEqual(['mainnet', 'testnet']); // unchanged until confirmed
    expect(row.verified).toBe(true);
  });

  it('confirming an unknown token returns undefined', async () => {
    expect(await confirmSubscription(sql, 'a'.repeat(32))).toBeUndefined();
  });

  it('a confirmation token is single-use: a second confirm attempt fails and the token is cleared', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'reuse@example.com' });
    const token = sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1];

    const first = await confirmSubscription(sql, token);
    expect(first?.endpoint).toBe('reuse@example.com');

    const second = await confirmSubscription(sql, token);
    expect(second).toBeUndefined();

    const [row] = await sql`select verify_token from subscriptions where endpoint = 'reuse@example.com'`;
    expect(row.verify_token).toBeNull();
  });

  it('a confirmation token older than 72 hours is refused; 71 hours is accepted', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'expiring@example.com' });
    const token = sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1];

    await sql`update subscriptions set verify_token_issued_at = now() - interval '73 hours' where endpoint = 'expiring@example.com'`;
    expect(await confirmSubscription(sql, token)).toBeUndefined();

    await startEmailSubscription(sql, sender, { email: 'expiring2@example.com' });
    const token2 = sent[1].text.match(/\/confirm\/([0-9a-f]{32})/)![1];
    await sql`update subscriptions set verify_token_issued_at = now() - interval '71 hours' where endpoint = 'expiring2@example.com'`;
    expect((await confirmSubscription(sql, token2))?.endpoint).toBe('expiring2@example.com');
  });

  // Regression test for a select-then-insert race: two near-simultaneous first-time
  // subscribes for the same email can both pass startEmailSubscription's initial
  // "does a row exist?" select, so the second call's insert loses to the unique
  // (channel, endpoint) constraint and would previously throw a raw Postgres
  // unique-violation. A true concurrent race (two separate requests interleaving at
  // the database level) is not reliably reproducible from a single test process —
  // a `Promise.all` of two `startEmailSubscription` calls was tried and empirically
  // did not trigger the catch(23505) path in repeated runs (postgres.js appears to
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
  // the row actually gets created — simulating the concurrent winner committing
  // first) and then throws a Postgres-shaped 23505 error, so startEmailSubscription's
  // own insert branch truly hits the catch block, re-selects the row, and falls
  // through to updateExistingAndNotify — proving that exact code path never throws
  // and sends exactly one confirmation email to the pre-existing row, with a freshly
  // issued token (updateExistingAndNotify's unverified branch always mints a new
  // one rather than resending whatever the race-winning insert produced).
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
    const [row] = await sql`select id, filter_severities, verified, verify_token from subscriptions where endpoint = 'race2@example.com'`;
    expect(sent[0].text).toContain(`/confirm/${row.verify_token}`);
    expect(row.verify_token).not.toBe(realSub!.verifyToken);
    expect(row.id).toBe(realSub!.id);
    expect(row.filter_severities).toEqual(['critical']);
    expect(row.verified).toBe(false);
  });

  it('a verified subscriber gets a confirm-change email; filters change only after confirming', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'cc@example.com' });
    await confirmSubscription(sql, sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1]);

    const res = await startEmailSubscription(sql, sender, {
      email: 'cc@example.com', filters: { severities: ['info'] }, baseUrl: 'https://announce.example',
    });
    expect(res).toBe('change_pending');
    const [before] = await sql`select filter_severities, pending_filters from subscriptions where endpoint = 'cc@example.com'`;
    expect(before.filter_severities).toEqual(['critical', 'recommended', 'info']); // unchanged
    expect(before.pending_filters).not.toBeNull();

    const token = sent[1].text.match(/\/confirm-change\/([0-9a-f]{32})/)![1];
    expect(await confirmFilterChange(sql, token)).toBe(true);
    const [after] = await sql`select filter_severities, pending_filters, pending_token, pending_token_issued_at from subscriptions where endpoint = 'cc@example.com'`;
    expect(after.filter_severities).toEqual(['info']);
    expect(after.pending_filters).toBeNull();
    expect(after.pending_token).toBeNull(); // single-use
    expect(after.pending_token_issued_at).toBeNull();
  });

  it('confirmFilterChange rejects an unknown token', async () => {
    expect(await confirmFilterChange(sql, 'a'.repeat(32))).toBe(false);
  });

  it('a pending-change token older than 72 hours is refused; 71 hours is accepted', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'change-expiring@example.com' });
    await confirmSubscription(sql, sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1]);

    await startEmailSubscription(sql, sender, {
      email: 'change-expiring@example.com', filters: { severities: ['info'] },
    });
    const token = sent[1].text.match(/\/confirm-change\/([0-9a-f]{32})/)![1];

    await sql`update subscriptions set pending_token_issued_at = now() - interval '73 hours' where endpoint = 'change-expiring@example.com'`;
    expect(await confirmFilterChange(sql, token)).toBe(false);
    const [row] = await sql`select filter_severities from subscriptions where endpoint = 'change-expiring@example.com'`;
    expect(row.filter_severities).toEqual(['critical', 'recommended', 'info']); // unchanged

    await startEmailSubscription(sql, sender, { email: 'change-expiring2@example.com' });
    await confirmSubscription(sql, sent[2].text.match(/\/confirm\/([0-9a-f]{32})/)![1]);
    await startEmailSubscription(sql, sender, {
      email: 'change-expiring2@example.com', filters: { severities: ['info'] },
    });
    const token2 = sent[3].text.match(/\/confirm-change\/([0-9a-f]{32})/)![1];
    await sql`update subscriptions set pending_token_issued_at = now() - interval '71 hours' where endpoint = 'change-expiring2@example.com'`;
    expect(await confirmFilterChange(sql, token2)).toBe(true);
  });

  it('requesting a new filter change issues a fresh token and a fresh pending_token_issued_at', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'change-refresh@example.com' });
    await confirmSubscription(sql, sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1]);

    await startEmailSubscription(sql, sender, {
      email: 'change-refresh@example.com', filters: { severities: ['info'] },
    });
    const firstToken = sent[1].text.match(/\/confirm-change\/([0-9a-f]{32})/)![1];
    const [before] = await sql`select pending_token, pending_token_issued_at from subscriptions where endpoint = 'change-refresh@example.com'`;

    await sql`update subscriptions set pending_token_issued_at = now() - interval '1 hour' where endpoint = 'change-refresh@example.com'`;

    await startEmailSubscription(sql, sender, {
      email: 'change-refresh@example.com', filters: { severities: ['critical'] },
    });
    const secondToken = sent[2].text.match(/\/confirm-change\/([0-9a-f]{32})/)![1];
    const [after] = await sql`select pending_token, pending_token_issued_at from subscriptions where endpoint = 'change-refresh@example.com'`;

    expect(secondToken).not.toBe(firstToken);
    expect(after.pending_token).toBe(secondToken);
    expect(before.pending_token).not.toBe(after.pending_token);
    expect(new Date(after.pending_token_issued_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

// migrations/018_subscriptions_email_lowercase.sql's collapse-then-lowercase
// step, exercised against a temp table with the same shape as `subscriptions`
// rather than the migrated table itself (which already carries the resulting
// check constraint and a schema_migrations row marking 018 applied). Same
// approach as the publishers-lowercase test in identity.test.ts.
//
// The survivor rule is richer here than for publishers: a verified row is a
// person who proved ownership of the address, so it must outlive the
// unverified duplicates regardless of insertion order. Only when the verified
// count is not exactly one does the earliest-wins `(created_at, ctid)` order
// decide.
describe('subscriptions-email-lowercase migration collapse', () => {
  async function collapse(tx: TransactionSql): Promise<void> {
    await tx`delete from subs_mig_test s
      using subs_mig_test t
      where s.channel = 'email' and t.channel = 'email'
        and lower(s.endpoint) = lower(t.endpoint)
        and s.endpoint <> t.endpoint
        and (
          s.verified < t.verified
          or (s.verified = t.verified and (s.created_at, s.ctid) > (t.created_at, t.ctid))
        )`;
    await tx`update subs_mig_test set endpoint = lower(endpoint)
      where channel = 'email' and endpoint <> lower(endpoint)`;
  }

  async function tempTable(tx: TransactionSql): Promise<void> {
    await tx`create temporary table subs_mig_test (
      channel    text not null,
      endpoint   text not null,
      verified   boolean not null default false,
      created_at timestamptz not null default now(),
      unique (channel, endpoint)
    ) on commit drop`;
  }

  it('keeps the single verified row, lowercased, when three casings collide', async () => {
    await sql.begin(async tx => {
      await tempTable(tx);
      await tx`insert into subs_mig_test (channel, endpoint, verified, created_at) values
        ('email', 'Alice@X', false, '2026-01-01T00:00:00Z'),
        ('email', 'alice@x', true,  '2026-01-02T00:00:00Z'),
        ('email', 'ALICE@X', false, '2026-01-03T00:00:00Z')`;
      await collapse(tx);
      const rows = await tx`select endpoint, verified from subs_mig_test`;
      expect(rows.length).toBe(1);
      expect(rows[0].endpoint).toBe('alice@x');
      expect(rows[0].verified).toBe(true);
    });
  });

  it('falls back to earliest-wins when no row is verified', async () => {
    await sql.begin(async tx => {
      await tempTable(tx);
      await tx`insert into subs_mig_test (channel, endpoint, verified, created_at) values
        ('email', 'Bob@X', false, '2026-01-01T00:00:00Z'),
        ('email', 'BOB@X', false, '2026-01-02T00:00:00Z')`;
      await collapse(tx);
      const rows = await tx`select endpoint, verified from subs_mig_test`;
      expect(rows.length).toBe(1);
      expect(rows[0].verified).toBe(false);
    });
  });

  it('falls back to earliest-wins when more than one row is verified', async () => {
    await sql.begin(async tx => {
      await tempTable(tx);
      await tx`insert into subs_mig_test (channel, endpoint, verified, created_at) values
        ('email', 'Carol@X', true, '2026-01-01T00:00:00Z'),
        ('email', 'CAROL@X', true, '2026-01-02T00:00:00Z')`;
      await collapse(tx);
      const rows = await tx`select endpoint, verified from subs_mig_test`;
      expect(rows.length).toBe(1);
      expect(rows[0].endpoint).toBe('carol@x');
      expect(rows[0].verified).toBe(true);
    });
  });

  it('leaves webhook rows alone, mixed case and all', async () => {
    await sql.begin(async tx => {
      await tempTable(tx);
      await tx`insert into subs_mig_test (channel, endpoint) values
        ('webhook', 'https://Example.com/Hook'),
        ('webhook', 'https://example.com/hook')`;
      await collapse(tx);
      const rows = await tx`select endpoint from subs_mig_test order by endpoint`;
      expect(rows.length).toBe(2);
    });
  });

  it('is a no-op on an already-lowercase table (re-running is safe)', async () => {
    await sql.begin(async tx => {
      await tempTable(tx);
      await tx`insert into subs_mig_test (channel, endpoint, verified) values
        ('email', 'dave@x', true), ('email', 'erin@x', false)`;
      await collapse(tx);
      await collapse(tx);
      const rows = await tx`select endpoint from subs_mig_test order by endpoint`;
      expect(rows.map(r => r.endpoint)).toEqual(['dave@x', 'erin@x']);
    });
  });
});

describe('startEmailSubscription lowercases the address itself', () => {
  it('a mixed-case then lowercase subscribe yields ONE row', async () => {
    const { sender } = recorder();
    await startEmailSubscription(sql, sender, { email: 'Alice@Example.com' });
    await startEmailSubscription(sql, sender, { email: 'alice@example.com' });
    const rows = await sql`select endpoint from subscriptions where channel = 'email'`;
    expect(rows.length).toBe(1);
    expect(rows[0].endpoint).toBe('alice@example.com');
  });

  it('trims surrounding whitespace as well', async () => {
    const { sender } = recorder();
    await startEmailSubscription(sql, sender, { email: '  Bob@Example.com  ' });
    const rows = await sql`select endpoint from subscriptions where channel = 'email'`;
    expect(rows.length).toBe(1);
    expect(rows[0].endpoint).toBe('bob@example.com');
  });
});
