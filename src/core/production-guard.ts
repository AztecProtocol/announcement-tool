/**
 * Startup checks that refuse to run this tool in a production configuration
 * where the admin surface could be reached by someone who is not on the
 * tailnet.
 *
 * WHY THIS EXISTS. Admin identity comes from the `Tailscale-User-Login` header
 * (src/core/identity.ts). That header is trivially forgeable by anyone who can
 * reach the port. It is trustworthy for exactly one reason: the app binds to
 * loopback and `tailscale serve` is the only route in. Nothing else enforces
 * that — so these checks do.
 *
 * A misconfigured instance that RUNS is far worse than one that refuses to
 * start: a refusal is noticed at once; an open admin surface is not, until an
 * announcement nobody approved is posted to five channels. Discord role
 * mentions cannot be un-sent.
 *
 * These functions are pure and take their input as an argument rather than
 * reading process.env, so they can be tested exhaustively without mutating
 * global state between tests.
 */

export interface GuardEnv {
  /**
   * Deliberately UNREAD. Kept on the interface so the tests can prove the gate
   * ignores it: checksApply() must return true for 'staging', 'development' and
   * undefined alike. Gating on NODE_ENV was the original bug — `next start` only
   * DEFAULTS it (next/dist/bin/next: `process.env.NODE_ENV || defaultEnv`), so
   * `NODE_ENV=staging next start` silently disabled every check while the app
   * served admin traffic. Do not reintroduce a branch on this field.
   */
  nodeEnv?: string;
  adminEmail?: string;
  hostname?: string;
  publicBaseUrl?: string;
  allowInsecureDev?: string;
}

/** Loopback only. Anything else means the port is reachable off-host. */
const LOOPBACK = new Set(['127.0.0.1', '::1']);

/**
 * Whether the safety checks apply. They apply EVERYWHERE except an explicit,
 * deliberate local opt-out.
 *
 * Deliberately NOT keyed on NODE_ENV === 'production'. `next start` only
 * DEFAULTS NODE_ENV to production (node_modules/next/dist/bin/next:66 is
 * `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv`), so
 * `NODE_ENV=staging next start` would otherwise disable every check while the
 * app served admin traffic. A guard that one unexpected env value switches off
 * is not a guard.
 *
 * The opt-out is a named variable nobody sets by accident, and it is the ONLY
 * way to skip the checks.
 */
export function checksApply(env: GuardEnv): boolean {
  return env.allowInsecureDev !== '1';
}

/**
 * Fatal configuration problems. An empty array means safe to start.
 *
 * Returns ALL problems rather than throwing on the first, so an operator fixes
 * one deployment and not three in sequence.
 *
 * Skips entirely only when checksApply(env) is false, i.e. ANNOUNCE_ALLOW_INSECURE_DEV=1
 * was set explicitly: this guard exists to stop a production mistake, and a guard
 * that obstructs local work is a guard somebody switches off.
 */
export function checkEnvironment(env: GuardEnv): string[] {
  if (!checksApply(env)) return [];
  const problems: string[] = [];

  if (env.adminEmail) {
    problems.push(
      'ADMIN_EMAIL is set. It is the development-only identity fallback: '
      + 'with it set, any request that arrives without a Tailscale header is treated as this '
      + 'user and may publish. Unset it.',
    );
  }

  if (!env.hostname || !LOOPBACK.has(env.hostname)) {
    problems.push(
      `HOSTNAME must be 127.0.0.1 or ::1 (got ${env.hostname ?? 'unset'}). `
      + 'Unset, the server binds every interface, so the forgeable Tailscale identity header '
      + 'could be sent by anyone who can reach the port. Bind loopback and put `tailscale serve` '
      + 'in front.',
    );
  }

  if (!env.publicBaseUrl) {
    problems.push(
      'PUBLIC_BASE_URL must be set. Unset, it defaults to a compiled-in host, '
      + 'so confirmation and unsubscribe links sent to real subscribers point at the wrong site.',
    );
  } else if (!env.publicBaseUrl.startsWith('https://')) {
    problems.push(
      `PUBLIC_BASE_URL must be https (got ${env.publicBaseUrl}). `
      + 'Unsubscribe and confirmation tokens travel in these links.',
    );
  }

  return problems;
}
