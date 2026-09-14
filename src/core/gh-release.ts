/**
 * The official GitHub release page pattern for an upgrade announcement.
 *
 * Lives in its own module because the compose form (a client component)
 * needs it. The rest of the validation lives in validate.ts, which imports
 * zod, and zod probes `Function("")` at first use to decide whether it may
 * compile parsers. Under the nonce-based Content-Security-Policy that probe
 * is an unsafe-eval violation, so zod must not reach the browser bundle.
 */
export const GH_RELEASE = /^https:\/\/github\.com\/AztecProtocol\/[^/]+\/releases\//;
