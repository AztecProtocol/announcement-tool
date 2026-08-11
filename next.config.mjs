/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['postgres'],
  // TypeScript 7 (native compiler) doesn't expose the classic JS compiler API
  // that Next's type-checking step normally uses; this switches Next to shell
  // out to the `tsc` CLI instead. See: Next.js next-config-error TypeScript 7 notice.
  experimental: { useTypeScriptCli: true },
};
export default nextConfig;
