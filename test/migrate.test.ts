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
  // uses) against the local dev database creates announce_app. These tests
  // set a throwaway password on it via the owner connection, then connect
  // AS announce_app to prove the grant boundary the migration establishes:
  // normal publish-path writes work, DROP/ALTER is refused, DELETE on the
  // two append-only audit tables is refused, and DELETE on the two tables
  // the app code actually deletes from succeeds.
  const appUrl = URL.replace(/announce:announce@/, 'announce_app:app-role-test-pw@');

  it('grants the app role exactly what the code needs and nothing that can destroy audit history', async () => {
    await migrate(URL); // ensures 014_app_role.sql has run and created announce_app

    const owner = postgres(URL, { max: 1 });
    await owner`alter role announce_app with password 'app-role-test-pw'`;
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

      // Cannot drop a table — the role does not own it and has no DDL rights.
      await expect(app`drop table announcements`).rejects.toThrow(/must be owner/i);

      // Cannot erase the append-only audit tables.
      await expect(app`delete from audit_log`).rejects.toThrow(/permission denied/i);
      await expect(app`delete from delivery_ledger`).rejects.toThrow(/permission denied/i);
      await expect(app`update audit_log set actor = 'x'`).rejects.toThrow(/permission denied/i);

      // The two tables the app code actually deletes from (src/core/templates.ts,
      // src/core/tokens-flow.ts) must allow DELETE.
      await expect(app`delete from templates where id = 'does-not-exist'`).resolves.toBeDefined();
      await expect(app`delete from subscriptions where id = 'does-not-exist'`).resolves.toBeDefined();
    } finally {
      await app.end();
      const cleanup = postgres(URL, { max: 1 });
      await cleanup`delete from delivery_ledger where announcement_id = 'role-test'`;
      await cleanup`delete from announcements where id = 'role-test'`;
      await cleanup.end();
    }
  });
});
