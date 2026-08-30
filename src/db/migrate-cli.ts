import { migrate } from './migrate.js';
import { loadEnv } from '../env.js';
import { buildConnectionOptions, dbEnvFromProcessEnv } from './connect.js';
loadEnv();
// migrate() takes a bare connection string (it builds its own single-connection
// pool), so we only need the URL half of buildConnectionOptions here — but it
// is still the one place the local-dev fallback URL is defined, so this stays
// in sync with the other three call sites rather than carrying its own copy.
// TLS is not threaded through: migrations run from an operator's machine or
// CI against the fallback/dev database, not over the exposed connection the
// app processes use.
const { url } = buildConnectionOptions(dbEnvFromProcessEnv());
const applied = await migrate(url!);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
