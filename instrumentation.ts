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
  // This same Next.js server runs both as `main`'s VM deployment (Tailscale
  // in front, DEPLOY_TARGET=vm) and as the Netlify deployment (Auth0 JWT
  // verified in middleware.ts, DEPLOY_TARGET=netlify) — see identity.ts's
  // header comment. DEPLOY_TARGET is read here rather than inferred from
  // which other vars are set, so a half-configured environment fails the
  // "unrecognized shape" branch in checkEnvironment instead of silently
  // picking one identity model.
  const guardEnv = {
    deployTarget: process.env.DEPLOY_TARGET as 'vm' | 'netlify' | undefined,
    adminEmail: process.env.ADMIN_EMAIL,
    hostname: process.env.HOSTNAME,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    allowInsecureDev: process.env.ANNOUNCE_ALLOW_INSECURE_DEV,
    auth0Issuer: process.env.AUTH0_ISSUER ?? (process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}/` : undefined),
    auth0Audience: process.env.AUTH0_AUDIENCE ?? process.env.AUTH0_CLIENT_ID,
  };
  const problems = checkEnvironment(guardEnv);

  if (problems.length > 0) {
    const detail = problems.map(p => `  - ${p}`).join('\n');
    throw new Error(`Refusing to start: unsafe production configuration.\n${detail}`);
  }

  const { assertPublishersConfigured } = await import('./src/core/identity.js');
  const { getDb } = await import('./src/web/db.js');
  await assertPublishersConfigured(getDb(), guardEnv);
}
