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
 * SECURITY: this function is a public HTTP endpoint — Netlify puts nothing
 * in front of it. checkEnvironment/assertPublishersConfigured below verify
 * the *configuration* is safe; they say nothing about *who* is calling. The
 * TICK_SECRET check is what stops anyone who finds this URL from forcing
 * repeated fan-out ticks (ESP quota burn, Discord/Telegram rate-limit churn,
 * load on a sleeping database). It runs FIRST, before any config check and
 * before any database connection, and fails closed: an unset/empty
 * TICK_SECRET refuses every request rather than allowing them. The
 * comparison itself lives in src/core/tick-auth.ts, not here, because that
 * is what the test suite can reach — this file only wires it in.
 *
 * https://docs.netlify.com/build/functions/background-functions/
 */
import postgres from 'postgres';
import { loadEnv } from '../../src/env.js';
loadEnv();
import { checkEnvironment } from '../../src/core/production-guard.js';
import { assertPublishersConfigured } from '../../src/core/identity.js';
import { tickSecretMatches } from '../../src/core/tick-auth.js';
import { runTick } from '../../src/worker/tick.js';
import { buildAdapters } from '../../src/worker/adapters.js';
import { senderFromEnv } from '../../src/adapters/esp.js';

export default async (req: Request): Promise<Response | void> => {
  // Refuse with a 404 rather than 401/403: this endpoint is not meant to be
  // known about at all, and a 401/403 confirms to a prober that something
  // real is here. A 404 looks identical to "no such route".
  const presented = req.headers.get('x-tick-secret');
  if (!tickSecretMatches(process.env.TICK_SECRET, presented)) {
    console.error('tick-background: refusing request, missing or wrong x-tick-secret.');
    return new Response('Not found', { status: 404 });
  }

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
