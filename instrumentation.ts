/**
 * Next's server-startup hook. Runs once when the server boots — this is the
 * only place the web app can fail fast, because it has no entry point of its
 * own (Next loads .env itself, so src/env.ts's loadEnv is never called here).
 *
 * Throwing aborts startup, which is the intended behaviour: see
 * src/core/production-guard.ts for why a misconfigured instance must not run.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { checkEnvironment } = await import('./src/core/production-guard.js');
  const problems = checkEnvironment({
    adminEmail: process.env.ADMIN_EMAIL,
    hostname: process.env.HOSTNAME,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
  });

  if (problems.length > 0) {
    const detail = problems.map(p => `  - ${p}`).join('\n');
    throw new Error(`Refusing to start: unsafe production configuration.\n${detail}`);
  }

  const { assertPublishersConfigured } = await import('./src/core/identity.js');
  const { getDb } = await import('./src/web/db.js');
  await assertPublishersConfigured(getDb(), {
    adminEmail: process.env.ADMIN_EMAIL,
    hostname: process.env.HOSTNAME,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
  });
}
