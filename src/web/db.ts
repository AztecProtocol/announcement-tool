import { type Sql } from 'postgres';
import { connect, dbEnvFromProcessEnv } from '../db/connect.js';

const g = globalThis as unknown as { __announceSql?: Sql };

/** One pool per process; cached on globalThis so Next dev hot-reload reuses it. */
export function getDb(): Sql {
  g.__announceSql ??= connect(dbEnvFromProcessEnv(), 5);
  return g.__announceSql;
}
