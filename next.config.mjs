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
};
export default nextConfig;
