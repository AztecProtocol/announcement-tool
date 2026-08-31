import { migrate } from './migrate.js';
import { loadEnv } from '../env.js';
import { buildConnectionOptions, dbEnvFromProcessEnv, resolveCaFile } from './connect.js';
loadEnv();
// On the split deployment, DATABASE_URL points at the VM's Postgres over the
// public internet — README.md documents DATABASE_URL as used "by the worker
// ... and migrations", and there is no longer a same-host compose `migrate`
// service to fall back to. So this must get the same verifying TLS as the
// app's own connections, resolved by the one shared connect.ts, not a
// URL-only shortcut that silently drops options.ssl.
const { url, ...options } = buildConnectionOptions(dbEnvFromProcessEnv());
resolveCaFile(options);
const applied = await migrate(url!, undefined, options);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
