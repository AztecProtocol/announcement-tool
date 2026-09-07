/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['postgres'],
  // TypeScript 7 (native compiler) doesn't expose the classic JS compiler API
  // that Next's type-checking step normally uses; this switches Next to shell
  // out to the `tsc` CLI instead. See: Next.js next-config-error TypeScript 7 notice.
  experimental: { useTypeScriptCli: true },
  // The dev server refuses cross-origin requests it doesn't recognise, which
  // leaves client components un-hydrated (forms render but do nothing) when the
  // site is browsed over a host other than localhost — e.g. a test server's IP.
  // DEV ONLY: `next start` in production ignores this. Set DEV_ORIGIN to the
  // host you browse, e.g. DEV_ORIGIN=167.233.212.20 — entries must be bare
  // hostnames, so any port or scheme given here is stripped.
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    ...(process.env.DEV_ORIGIN
      ? [process.env.DEV_ORIGIN.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0]]
      : []),
  ],
  async headers() {
    // Enforced directives only. script-src/style-src are left out on purpose:
    // Next injects inline scripts and styles, and a nonce strategy is a
    // separate change. What is here contains framing, plugins, base-URI and
    // form targets without touching how the page renders.
    //
    // form-action 'self' cannot break the Auth0 login flow: GET /admin/login
    // (app/admin/login/route.ts) answers with a 303 redirect to Auth0, not a
    // form post, and GET /admin/callback (app/admin/callback/route.ts) only
    // ever receives Auth0's redirect back, also not a form post. Neither
    // route submits a form to a third-party origin.
    const csp = "default-src 'self' https: data: 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};
export default nextConfig;
