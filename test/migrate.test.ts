import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { migrate } from '../src/db/migrate.js';

const URL = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';

describe('migrate', () => {
  it('applies pending .sql files once, in order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '001_a.sql'), 'create table if not exists mig_t (n int);');
    writeFileSync(join(dir, '002_b.sql'), 'insert into mig_t (n) values (1);');
    const first = await migrate(URL, dir);
    expect(first).toEqual(['001_a.sql', '002_b.sql']);
    const second = await migrate(URL, dir);
    expect(second).toEqual([]); // idempotent — nothing re-applied
    const sql = postgres(URL, { max: 1 });
    const rows = await sql`select count(*)::int as c from mig_t`;
    expect(rows[0].c).toBe(1);
    await sql`drop table mig_t`;
    await sql`delete from schema_migrations where name in ('001_a.sql','002_b.sql')`;
    await sql.end();
  });
});

describe('announce_app role (least-privilege app credential — migrations/014_app_role.sql)', () => {
  // Applying the real migrations/ directory (the default `dir` migrate()
  // uses) against the local dev database creates announce_app NOLOGIN. This
  // test enables login with a throwaway password via the owner connection,
  // then connects AS announce_app to prove the grant boundary the migration
  // establishes: normal publish-path writes/reads work, DROP/ALTER is
  // refused, DELETE on the two append-only audit tables is refused, INSERT
  // on publishers and UPDATE on channel_settings are refused (the two
  // grants a prior version of this migration got wrong — see the review
  // notes in migrations/014_app_role.sql), and DELETE on the two tables the
  // app code actually deletes from succeeds against real rows.
  //
  // This test mutates announce_app's login state and password on whatever
  // database URL it runs against, so it refuses to run against anything but
  // a local database — same instinct as src/core/production-guard.ts, just
  // applied to "is this my throwaway dev database" instead of "is this
  // reachable off the tailnet".
  const host = new globalThis.URL(URL).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  const appUrl = URL.replace(/announce:announce@/, 'announce_app:app-role-test-pw@');
  // If DATABASE_URL's credentials are not literally announce:announce, the
  // replace above silently no-ops and appUrl === URL — which would mean the
  // "app role" checks below actually run as the OWNER, passing every
  // assertion for the wrong reason (e.g. `drop table` would SUCCEED and
  // destroy the table, not get refused). Guard against that explicitly.
  const rewriteTookEffect = appUrl !== URL;

  it.runIf(isLocal && rewriteTookEffect)(
    'grants the app role exactly what the code needs and nothing that can destroy audit history or defeat four-eyes',
    async () => {
      await migrate(URL); // ensures 014_app_role.sql has run and created announce_app

      const owner = postgres(URL, { max: 1 });
      await owner`alter role announce_app with login password 'app-role-test-pw'`;
      await owner.end();

      const app = postgres(appUrl, { max: 1 });
      try {
        // Normal publish-path operations work.
        await app`
          insert into announcements
            (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by)
          values
            ('role-test', 1, 'role-test-slug', 'info', '{mainnet}', '{operators}', 'info', 't', 'b', 'draft', 'tester')
        `;
        await app`
          insert into delivery_ledger (announcement_id, revision, channel, target)
          values ('role-test', 1, 'webhook', 'sub-role-test')
        `;
        await expect(app`select key, channel, config from channel_settings limit 1`).resolves.toBeDefined();
        await expect(app`select email from publishers limit 1`).resolves.toBeDefined();

        // Cannot drop a table — the role does not own it and has no DDL rights.
        await expect(app`drop table announcements`).rejects.toThrow(/must be owner/i);

        // Cannot erase the append-only audit tables.
        await expect(app`delete from audit_log`).rejects.toThrow(/permission denied/i);
        await expect(app`delete from delivery_ledger`).rejects.toThrow(/permission denied/i);
        await expect(app`update audit_log set actor = 'x'`).rejects.toThrow(/permission denied/i);

        // Cannot manufacture a four-eyes identity or hijack a delivery destination.
        await expect(
          app`insert into publishers (email) values ('attacker@evil.tld')`,
        ).rejects.toThrow(/permission denied/i);
        await expect(
          app`update channel_settings set config = '{}'::jsonb where key = 'does-not-exist'`,
        ).rejects.toThrow(/permission denied/i);

        // The two tables the app code actually deletes from (src/core/templates.ts,
        // src/core/tokens-flow.ts) must allow DELETE — proven against a real row,
        // not a no-op match, so the assertion carries the same weight as the
        // manual psql verification.
        await app`insert into templates (id, name, input, created_by) values ('role-test-tmpl', 'role-test-tmpl-name', '{}', 'tester')`;
        const tmplDel = await app`delete from templates where id = 'role-test-tmpl'`;
        expect(tmplDel.count).toBe(1);

        await app`insert into subscriptions (id, channel, endpoint, unsubscribe_token) values ('role-test-sub', 'webhook', 'https://example.test/role-test', 'role-test-token')`;
        const subDel = await app`delete from subscriptions where id = 'role-test-sub'`;
        expect(subDel.count).toBe(1);
      } finally {
        await app.end();
        const cleanup = postgres(URL, { max: 1 });
        await cleanup`delete from delivery_ledger where announcement_id = 'role-test'`;
        await cleanup`delete from announcements where id = 'role-test'`;
        await cleanup`delete from templates where id = 'role-test-tmpl'`;
        await cleanup`delete from subscriptions where id = 'role-test-sub'`;
        await cleanup.end();
      }
    },
  );

  it.runIf(isLocal)('a freshly-created announce_app cannot log in until login is explicitly granted', async () => {
    // Reset to the migration's own starting state (NOLOGIN, no password) so
    // this assertion is about what the migration produces, not leftover
    // state from the test above.
    const owner = postgres(URL, { max: 1 });
    await owner`alter role announce_app with nologin password null`;
    await owner.end();

    // psql surfaces Postgres's own message here — "FATAL: role ... is not
    // permitted to log in" — confirmed manually with psql against this same
    // database while writing this test. postgres.js (the driver the app and
    // this test suite use) aborts its own SASL handshake before the server
    // gets to report that, and surfaces "password authentication failed"
    // instead. Either way the connection is refused, which is the property
    // that matters: asserting the driver-visible message keeps this test
    // honest about what postgres.js actually does, rather than a message
    // this codebase would never see in practice.
    const app = postgres(appUrl, { max: 1, connect_timeout: 5 });
    await expect(app`select 1`).rejects.toThrow(/password authentication failed/i);
    await app.end();

    // Restore login for any later run of the test above in the same suite invocation.
    const restore = postgres(URL, { max: 1 });
    await restore`alter role announce_app with login password 'app-role-test-pw'`;
    await restore.end();
  });
});
