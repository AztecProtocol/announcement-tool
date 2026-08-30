/**
 * The one place that turns environment configuration into a database
 * connection.
 *
 * WHY THIS EXISTS. Before this file there were four independent
 * `postgres(url, { max: N })` calls (web, worker, the Netlify tick function,
 * the migration CLI), each with its own copy of the local-dev fallback URL.
 * That is exactly how the four drift apart: a change to how the URL is
 * resolved, or to how TLS is configured, has to be made — and kept correct —
 * in four places instead of one. Centralising first, before TLS is added, is
 * deliberate: it means TLS is added once, not reconciled four times.
 *
 * This database is not "just announcements". channel_settings.config holds
 * the Discord webhook URL and Telegram bot token; subscriptions.endpoint
 * holds every subscriber's email; subscriptions.secret holds per-subscriber
 * webhook signing secrets; and the publisher list lives here too. On the VM
 * deployment this traveled over a private Tailscale network. On the split
 * deployment the database sits on a Hetzner VM with its port exposed to the
 * public internet — there is no tailnet standing between an attacker and
 * that data, so the connection itself has to be the defense.
 *
 * `sslmode=require` is refused rather than accepted as a lesser option.
 * `require` encrypts the connection but does not verify the server's
 * certificate, so it stops a passive eavesdropper and nothing else: an
 * attacker who can redirect the connection (DNS, ARP, a rogue route) can
 * present any certificate and be accepted. The credentials behind this
 * connection can read every subscriber email and post to Discord and
 * Telegram as the Foundation, so a guarantee that looks like TLS but only
 * defeats half the threat model is a misconfiguration, not a weaker option
 * an operator gets to choose. Only `verify-full` — which checks both the
 * certificate chain and the hostname — is accepted.
 *
 * A missing CA bundle under `verify-full` is fatal for the same reason:
 * without an explicit CA, the driver would fall back to the system trust
 * store, which may or may not contain the issuer for a self-hosted Postgres
 * instance. That failure is silent — the connection still succeeds, just
 * against whatever the system happens to trust — so the operator would
 * believe they have a verified connection when they do not. Refusing to
 * start is loud and immediate; a false sense of verification is neither.
 *
 * DATABASE_SSL_MODE/DATABASE_SSL_ROOT_CERT are NOT the only place TLS could
 * be set: postgres.js's own parseOptions (node_modules/postgres/src/index.js)
 * reads `?sslmode=` and `?sslrootcert=system` directly out of the connection
 * string and turns them into its `ssl` option — including `?sslmode=require`,
 * which is exactly the half-guarantee this file exists to refuse. If we only
 * validated our own env vars and passed the URL through untouched, an
 * operator writing the connection string the way every Postgres tutorial and
 * managed-provider console does (`?sslmode=require` in DATABASE_URL) would
 * bypass this file's refusal completely and connect encrypted-but-unverified
 * with no error and no warning. So buildConnectionOptions checks the URL for
 * both parameters and throws if either is present: there is exactly one
 * authority for TLS configuration here, not two competing ones.
 *
 * That check runs in two layers, not one. A `new URL()` parse handles the
 * common case, but postgres.js also accepts a multi-host connection string
 * (`postgres://u:p@h1:5432,h2:5432/db`, a normal Postgres HA form) that
 * `new URL()` rejects outright — postgres.js only manages to parse it by
 * rewriting the string to its first host before parsing. A version of this
 * check that silently skipped validation whenever `new URL()` threw would
 * therefore let exactly the multi-host + `?sslmode=require` combination
 * through unchecked: real syntax, a real bypass, not a hypothetical one. So a
 * second, unconditional regex scan of the raw string backs up the parser —
 * see buildConnectionOptions for both.
 */

import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';

export interface DbEnv {
  databaseUrl?: string;
  sslMode?: string;
  sslRootCert?: string;
}

/**
 * postgres.Options<T> does not itself declare `url` — the library takes the
 * connection string as `postgres(url, options)`'s first argument, separate
 * from Options. We fold it into one object because it is one resolved
 * connection target as far as every caller here is concerned.
 */
export type ConnectionOptions = postgres.Options<{}> & { url?: string };

/** Local dev and the docker-compose network both use this, over a private link. */
const DEFAULT_URL = 'postgres://announce:announce@127.0.0.1:5499/announce';

/**
 * Pure — no filesystem or network access — so it can be unit-tested without
 * a database and without a CA file on disk. The CA bundle itself is read
 * lazily by connect(), once a real connection is about to be made; here we
 * only validate that a path was given and remember it.
 */
export function buildConnectionOptions(env: DbEnv): ConnectionOptions {
  const url = env.databaseUrl ?? DEFAULT_URL;

  // postgres.js reads `sslmode`/`sslrootcert` straight out of the URL's own
  // query string and turns them into its `ssl` option, bypassing every check
  // below. Refuse both outright so DATABASE_SSL_MODE/DATABASE_SSL_ROOT_CERT
  // are the one place TLS is configured, not one of two competing places.
  //
  // A multi-host connection string (postgres://u:p@h1:5432,h2:5432/db, a
  // normal Postgres HA form) throws out of `new URL()` directly: postgres.js's
  // own parseUrl (node_modules/postgres/src/index.js) rewrites the string to
  // its first host before calling `new URL()` internally, but nothing here
  // does that rewrite first. So the WHATWG parse below is not a reliable way
  // to see every query parameter postgres.js will see, and the string-level
  // regex immediately after it is not a "belt and suspenders" extra — it is
  // the check that actually covers every URL shape postgres.js accepts. It
  // runs unconditionally, in addition to the parser-based check, and there is
  // no catch-and-continue path here: a URL this file cannot make sense of is
  // exactly the case the regex exists for, not a reason to skip validation.
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed?.searchParams.has('sslmode')) {
    throw new Error(
      `DATABASE_URL must not set "sslmode" in its query string (found "?sslmode=`
      + `${parsed.searchParams.get('sslmode')}"). postgres.js reads that parameter directly and `
      + 'it would bypass this module\'s checks entirely. Set DATABASE_SSL_MODE instead and '
      + 'remove sslmode from DATABASE_URL.',
    );
  }
  if (parsed?.searchParams.has('sslrootcert')) {
    throw new Error(
      `DATABASE_URL must not set "sslrootcert" in its query string (found "?sslrootcert=`
      + `${parsed.searchParams.get('sslrootcert')}"). postgres.js reads that parameter directly `
      + '(and "system" silently becomes verify-full) which would bypass this module\'s checks '
      + 'entirely. Set DATABASE_SSL_ROOT_CERT instead and remove sslrootcert from DATABASE_URL.',
    );
  }
  // Backstop for URL shapes the WHATWG parser above cannot handle at all
  // (multi-host being the confirmed live case) — a plain, case-insensitive
  // scan of the raw string for a `?` or `&`-delimited sslmode/sslrootcert
  // parameter. Requiring that delimiter is deliberate: a percent-encoded
  // password containing "%3Fsslmode%3D" does not match (it has no literal
  // `?`/`&`), and a password containing a literal unescaped `&sslmode=` would
  // already be a malformed connection string that breaks parsing elsewhere —
  // so this is not a source of false positives on real credentials.
  if (/[?&]sslmode=/i.test(url)) {
    throw new Error(
      'DATABASE_URL must not set "sslmode" in its query string. postgres.js reads that parameter '
      + "directly — including from multi-host connection strings this module's own URL parser "
      + 'cannot read — and it would bypass this module\'s checks entirely. Set DATABASE_SSL_MODE '
      + 'instead and remove sslmode from DATABASE_URL.',
    );
  }
  if (/[?&]sslrootcert=/i.test(url)) {
    throw new Error(
      'DATABASE_URL must not set "sslrootcert" in its query string. postgres.js reads that '
      + 'parameter directly (and "system" silently becomes verify-full), including from multi-host '
      + "connection strings this module's own URL parser cannot read, which would bypass this "
      + 'module\'s checks entirely. Set DATABASE_SSL_ROOT_CERT instead and remove sslrootcert from '
      + 'DATABASE_URL.',
    );
  }

  const options: ConnectionOptions = { url };

  // Empty string is "unset" here, matching how ENABLED_CHANNELS treats a
  // blank value elsewhere (src/core/enabled-channels.ts,
  // src/core/production-guard.ts): docker-compose, the Netlify UI, and a
  // .env file with a bare `DATABASE_SSL_MODE=` all produce '' for "present
  // but blank", not for "deliberately require verify-full".
  const sslMode = env.sslMode === '' ? undefined : env.sslMode;

  switch (sslMode) {
    case undefined:
      // No ssl mode set: leave `ssl` undefined. Local dev and the
      // docker-compose network both talk plaintext over a private network,
      // and forcing TLS there would break every existing setup.
      break;

    case 'require':
      throw new Error(
        'DATABASE_SSL_MODE=require is not accepted: it encrypts the connection but does not '
        + 'verify the server certificate, so it stops a passive eavesdropper and not an active '
        + 'attacker. Use verify-full (with DATABASE_SSL_ROOT_CERT set) instead.',
      );

    case 'verify-full': {
      if (!env.sslRootCert) {
        throw new Error(
          'DATABASE_SSL_ROOT_CERT must be set when DATABASE_SSL_MODE=verify-full. Without an '
          + "explicit CA bundle, verification would silently fall back to the system trust store, "
          + 'which may not contain the issuer — a connection that looks verified but is not.',
        );
      }
      // The path is validated here; the file itself is read lazily by
      // connect() so this function stays pure and testable without a CA
      // file on disk. `ca` is a placeholder replaced there.
      options.ssl = { ca: env.sslRootCert, rejectUnauthorized: true };
      break;
    }

    default:
      throw new Error(
        `DATABASE_SSL_MODE must be unset or "verify-full" (got ${JSON.stringify(env.sslMode)}).`,
      );
  }

  return options;
}

/**
 * Reads the CA bundle buildConnectionOptions left as an unread path (see the
 * comment on the `verify-full` case above), mutating `options.ssl` in place.
 * Exported so every caller that needs a real, connectable set of options —
 * connect() below, and migrate-cli.ts, which passes options through to
 * migrate() instead of a bare URL — resolves the CA file the same way, once.
 * A no-op when there is no ssl.ca path to resolve.
 */
export function resolveCaFile(options: ConnectionOptions): void {
  if (options.ssl && typeof options.ssl === 'object' && 'ca' in options.ssl) {
    const ca = readFileSync((options.ssl as { ca: string }).ca, 'utf8');
    options.ssl = { ...options.ssl, ca };
  }
}

/**
 * Builds a connection with the given env, applying `max` on top of whatever
 * buildConnectionOptions resolved. `max` is deliberately a separate argument
 * rather than part of DbEnv: pool size is tuned per process (web, worker,
 * the Netlify tick function each have their own value), not something to
 * centralise alongside the connection target and TLS settings.
 */
export function connect(env: DbEnv = {}, max?: number): Sql {
  const options = buildConnectionOptions(env);
  const { url, ...rest } = options;
  resolveCaFile(rest);
  return postgres(url ?? DEFAULT_URL, { ...rest, ...(max === undefined ? {} : { max }) });
}

export function dbEnvFromProcessEnv(): DbEnv {
  return {
    databaseUrl: process.env.DATABASE_URL,
    sslMode: process.env.DATABASE_SSL_MODE,
    sslRootCert: process.env.DATABASE_SSL_ROOT_CERT,
  };
}
