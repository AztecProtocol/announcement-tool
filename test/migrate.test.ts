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
