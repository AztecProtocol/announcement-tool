/**
 * Next's server-startup hook. Runs once when the server boots — this is the
 * only place the web app can fail fast, because it has no entry point of its
 * own (Next loads .env itself, so src/env.ts's loadEnv is never called here).
 *
 * What is fatal and what is not: an unsafe environment (checkEnvironment) and
 * a publishers table that is reachable but empty or misconfigured throw, and
 * Next then stores that failed start for the life of the instance. An
 * unreachable database does NOT throw: the start check logs it and the
 * instance starts, because the real guarantee (an empty table authorises
 * nobody) is enforced per request by isPublisher. See src/core/production-guard.ts
 * for why a misconfigured instance must not run, and assertPublishersConfigured
 * for the outage that made the database check best-effort.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { checkEnvironment, guardEnvFromProcess } = await import('./src/core/production-guard.js');
  // One shared reader, so this hook and the per-request isPublisher check see
  // the same environment. See guardEnvFromProcess for the DEPLOY_TARGET note.
  const guardEnv = guardEnvFromProcess();
  const problems = checkEnvironment(guardEnv);

  if (problems.length > 0) {
    const detail = problems.map(p => `  - ${p}`).join('\n');
    throw new Error(`Refusing to start: unsafe production configuration.\n${detail}`);
  }

  const { assertPublishersConfigured } = await import('./src/core/identity.js');
  const { getDb } = await import('./src/web/db.js');
  await assertPublishersConfigured(getDb(), guardEnv);
}
