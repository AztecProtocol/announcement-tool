import postgres, { type Sql } from 'postgres';

const g = globalThis as unknown as { __announceSql?: Sql };

/** One pool per process; cached on globalThis so Next dev hot-reload reuses it. */
export function getDb(): Sql {
  g.__announceSql ??= postgres(
    process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce',
    { max: 5 },
  );
  return g.__announceSql;
}
