import postgres from 'postgres';
import { loadEnv } from '../env.js';
loadEnv();
import { checkEnvironment } from '../core/production-guard.js';
import { assertPublishersConfigured } from '../core/identity.js';
import { runTick } from './tick.js';
import { buildAdapters } from './adapters.js';
import { senderFromEnv } from '../adapters/esp.js';

// The worker does not bind a port, so HOSTNAME is not strictly its own
// concern — but it shares the environment with the web app, and a wrong
// HOSTNAME there means the web app is exposed. Failing both processes on
// the same environment is deliberate: one check, one story, easier to reason
// about than two different rules for two processes.
const problems = checkEnvironment({
  adminEmail: process.env.ADMIN_EMAIL,
  hostname: process.env.HOSTNAME,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
});
if (problems.length > 0) {
  console.error('Refusing to start: unsafe production configuration.');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const sql = postgres(url, { max: 4 });

try {
  await assertPublishersConfigured(sql, {
    adminEmail: process.env.ADMIN_EMAIL,
    hostname: process.env.HOSTNAME,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const sender = senderFromEnv();

const adapters = buildAdapters(sql, sender, ['webhook', 'discord', 'telegram', 'email', 'signal']);

console.log(`fan-out worker started (15s interval, scheduling on, esp=${sender.name}, channels=${Object.keys(adapters).join(',')})`);
setInterval(async () => {
  const { published, delivered, failed, alerted } = await runTick(sql, adapters, sender);
  for (const a of published) console.log(`scheduled publish sent: ${a.id} (${a.slug})`);
  if (delivered || failed) console.log(`fanout: delivered=${delivered} failed=${failed}`);
  if (alerted) console.log(`health alerts dispatched: ${alerted}`);
}, 15_000);
