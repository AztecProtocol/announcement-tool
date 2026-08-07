import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

export async function migrate(databaseUrl: string, dir = join(process.cwd(), 'migrations')): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1 });
  const applied: string[] = [];
  try {
    await sql`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await sql`select name from schema_migrations`).map(r => r.name as string));
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await sql.begin(async tx => {
        await tx.unsafe(readFileSync(join(dir, f), 'utf8'));
        await tx`insert into schema_migrations (name) values (${f})`;
      });
      applied.push(f);
    }
    return applied;
  } finally {
    await sql.end();
  }
}
