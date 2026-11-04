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
 * Which channels run here is deployment configuration (ENABLED_CHANNELS), not
 * a property of this host — src/worker/adapters.ts builds its map from that
 * one variable on both hosts now. On its own, an unset ENABLED_CHANNELS would
 * mean "all five" here too, which would build a Signal adapter with no
 * signal-cli sidecar to reach and fail every Signal delivery. checkEnvironment
 * below (src/core/production-guard.ts) is what actually enforces the Netlify
 * deployment omits 'signal': it refuses to start unless ENABLED_CHANNELS is
 * set and does not name 'signal'. The VM enables Signal once a phone number
 * exists. See src/core/enabled-channels.ts.
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
import { loadEnv } from '../../src/env.js';
loadEnv();
import { checkEnvironment, guardEnvFromProcess } from '../../src/core/production-guard.js';
import { assertPublishersConfigured } from '../../src/core/identity.js';
import { tickSecretMatches } from '../../src/core/tick-auth.js';
import { runTick } from '../../src/worker/tick.js';
import { buildAdapters } from '../../src/worker/adapters.js';
import { senderFromEnv } from '../../src/adapters/esp.js';
import { connect, dbEnvFromProcessEnv } from '../../src/db/connect.js';

export default async (req: Request): Promise<Response | void> => {
  // Refuse with a 404 rather than 401/403: this endpoint is not meant to be
  // known about at all, and a 401/403 confirms to a prober that something
  // real is here. A 404 looks identical to "no such route".
  const presented = req.headers.get('x-tick-secret');
  if (!tickSecretMatches(process.env.TICK_SECRET, presented)) {
    console.error('tick-background: refusing request, missing or wrong x-tick-secret.');
    return new Response('Not found', { status: 404 });
  }

  // This function only ever runs on the Netlify deployment — the VM's
  // equivalent is src/worker/main.ts, which sets DEPLOY_TARGET=vm. Hardcoding
  // 'netlify' here is a fact about which binary this is, matching that.
  // Every other field comes from guardEnvFromProcess, the same reader the
  // web app's start hook uses, so a check added there (DATABASE_SSL_MODE,
  // for example) cannot be missed here.
  const guardEnv = { ...guardEnvFromProcess(), deployTarget: 'netlify' as const };
  const problems = checkEnvironment(guardEnv);
  if (problems.length > 0) {
    console.error('tick-background: refusing to run, unsafe production configuration.');
    for (const p of problems) console.error(`  - ${p}`);
    return;
  }

  const sql = connect(dbEnvFromProcessEnv(), 4);

  try {
    await assertPublishersConfigured(sql, guardEnv);
  } catch (err) {
    console.error('tick-background:', err instanceof Error ? err.message : err);
    await sql.end();
    return;
  }

  const sender = senderFromEnv();
  const adapters = buildAdapters(sql, sender);

  const { published, delivered, failed, alerted } = await runTick(sql, adapters, sender);
  for (const a of published) console.log(`scheduled publish sent: ${a.id} (${a.slug})`);
  if (delivered || failed) console.log(`fanout: delivered=${delivered} failed=${failed}`);
  if (alerted) console.log(`health alerts dispatched: ${alerted}`);

  await sql.end();
};

export const config = {
  background: true,
};
