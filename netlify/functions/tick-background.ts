/**
 * Background function: does the actual tick work. Netlify's legacy
 * `-background` filename suffix routes invocations here and allows up to 15
 * minutes of execution (vs. 30 seconds for the scheduled function that
 * triggers it).
 *
 * WIRING ONLY — no business logic here. Adapter construction lives in
 * src/worker/adapters.ts and the tick body lives in src/worker/tick.ts; both
 * are shared with the always-on VM worker (src/worker/main.ts) so there is
 * exactly one implementation of each.
 *
 * Signal is deliberately NOT in the channel list below: Netlify cannot run
 * the signal-cli sidecar, so registering it would produce failing deliveries
 * and health alerts for a channel with no way to succeed. The Signal adapter
 * itself is untouched and still used by the VM worker.
 *
 * https://docs.netlify.com/build/functions/background-functions/
 */
import postgres from 'postgres';
import { loadEnv } from '../../src/env.js';
loadEnv();
import { checkEnvironment } from '../../src/core/production-guard.js';
import { assertPublishersConfigured } from '../../src/core/identity.js';
import { runTick } from '../../src/worker/tick.js';
import { buildAdapters } from '../../src/worker/adapters.js';
import { senderFromEnv } from '../../src/adapters/esp.js';

export default async (): Promise<void> => {
  const problems = checkEnvironment({
    adminEmail: process.env.ADMIN_EMAIL,
    hostname: process.env.HOSTNAME,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
  });
  if (problems.length > 0) {
    console.error('tick-background: refusing to run, unsafe production configuration.');
    for (const p of problems) console.error(`  - ${p}`);
    return;
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
    console.error('tick-background:', err instanceof Error ? err.message : err);
    await sql.end();
    return;
  }

  const sender = senderFromEnv();
  const adapters = buildAdapters(sql, sender, ['webhook', 'discord', 'telegram', 'email']);

  const { published, delivered, failed, alerted } = await runTick(sql, adapters, sender);
  for (const a of published) console.log(`scheduled publish sent: ${a.id} (${a.slug})`);
  if (delivered || failed) console.log(`fanout: delivered=${delivered} failed=${failed}`);
  if (alerted) console.log(`health alerts dispatched: ${alerted}`);

  await sql.end();
};

export const config = {
  background: true,
};
