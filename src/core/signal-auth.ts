/**
 * Header the Signal adapter sends to prove it is the legitimate client of
 * the signal-cli-rest-api sidecar, once a later task puts a Caddy proxy in
 * front of it (split deployment: the Hetzner VM's sidecar is reachable from
 * the public internet, unlike the same-Docker-network VM deployment on
 * `main`). Exported as a named constant, not a string literal, so the Caddy
 * config that checks it (a different task, a different file) references
 * this name instead of re-typing it and risking drift.
 */
export const SIGNAL_AUTH_HEADER = 'x-announce-signal-secret';

/**
 * Builds the header the adapter attaches to every signal-cli-rest-api
 * request.
 *
 * Deliberate design: when `secret` is unset (or blank — Docker Compose, the
 * Netlify UI, and .env files all produce '' for "present but blank", so
 * blank is treated the same as unset, matching parseEnabledChannels and
 * DATABASE_SSL_MODE elsewhere in this codebase), this returns {} — no
 * header is sent at all. That keeps the existing same-Docker-network VM
 * deployment (branch `main`) working unchanged: there the sidecar is
 * unreachable from outside the private network, no secret is configured,
 * and none is needed.
 *
 * Do not "harden" this into throwing when `secret` is missing. signal-cli-
 * rest-api has no auth of its own — the Caddy proxy in front of it on the
 * split deployment is what fails closed, by rejecting any request that
 * lacks this header. A client that refuses to send a header it doesn't have
 * enforces nothing: it only breaks `main`'s deployment, where there is no
 * proxy and no secret to send, for zero security gain. The security
 * boundary lives in the proxy, not here.
 */
export function signalAuthHeaders(secret: string | undefined): Record<string, string> {
  if (secret === undefined || secret.trim() === '') return {};
  return { [SIGNAL_AUTH_HEADER]: secret };
}
