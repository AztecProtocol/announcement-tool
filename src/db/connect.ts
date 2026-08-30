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
      // The value is only validated as "present" here; resolveCaFile below
      // decides whether it is a file path or inline PEM content and reads
      // it there, lazily, so this function stays pure and testable without
      // touching the filesystem. `ca` is a placeholder resolved there.
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
 * Matches PEM content that begins (after leading whitespace) with the
 * standard `-----BEGIN CERTIFICATE-----` header. A real filesystem path
 * never starts with a dash the way PEM does, so this is an unambiguous way
 * to tell the two apart without an explicit "is this a path or a value"
 * flag on DbEnv.
 */
const PEM_HEADER = /^\s*-----BEGIN CERTIFICATE-----/;

/** The closing marker a well-formed inline PEM value must contain. */
const PEM_FOOTER = '-----END CERTIFICATE-----';

/**
 * Resolves DATABASE_SSL_ROOT_CERT's value, mutating `options.ssl.ca` in
 * place from whatever buildConnectionOptions left there (see the comment on
 * the `verify-full` case above). Exported so every caller that needs a
 * real, connectable set of options — connect() below, and migrate-cli.ts,
 * which passes options through to migrate() instead of a bare URL —
 * resolves the CA the same way, once. A no-op when there is no ssl.ca value
 * to resolve.
 *
 * ACCEPTS EITHER A FILE PATH OR INLINE PEM CONTENT. A file-path-only
 * contract works for the VM deployment and local dev, both of which have a
 * real filesystem to place a CA bundle on — but it is unsatisfiable on
 * Netlify. A Netlify serverless function has no filesystem to write a
 * certificate file to before start, and its environment variables can only
 * hold strings; there is no way to get a CA bundle from "a value Netlify's
 * UI can store" to "a path this process can read" on that shape. Before
 * this, DATABASE_SSL_MODE=verify-full (mandatory once Postgres is
 * internet-reachable — see buildConnectionOptions above) had no valid value
 * for DATABASE_SSL_ROOT_CERT on Netlify at all: the split deployment this
 * connector exists to support could not actually connect to its own
 * database. Detecting inline PEM by its own `-----BEGIN CERTIFICATE-----`
 * header (PEM_HEADER above) and using it directly, with a filesystem read
 * as the fallback for everything else, closes that gap without weakening
 * anything for the shapes that do have a filesystem: a bad path (typo,
 * wrong mount, missing file) still fails loudly via readFileSync throwing
 * ENOENT, not a silent unverified connection.
 *
 * ESCAPED NEWLINES: Netlify's environment variable UI (and many others)
 * accept genuine multi-line values, so a PEM pasted in as-is works with no
 * special handling. But pasting a certificate through some web UIs, or
 * through tooling that round-trips env vars as single-line JSON/shell
 * strings, is a well-known way for a certificate's real newlines to arrive
 * as the two literal characters `\` and `n` instead — the file has a
 * newline, the clipboard or the intermediate tool does not preserve it. A
 * PEM whose newlines were escaped this way still starts with the literal
 * text `-----BEGIN CERTIFICATE-----` (no backslash-n before the dashes),
 * so PEM_HEADER still matches it — but passing it to postgres.js's `ca`
 * option with literal `\n` sequences instead of real newlines produces a
 * cert Node's TLS layer cannot parse, and the resulting failure (an
 * unhelpful ASN.1/PEM parse error) gives an operator no hint that the fix
 * is "you pasted this with escaped newlines." So: whenever the detected PEM
 * value contains the literal two-character sequence `\n` and no *real*
 * newline character, this unescapes it (`\n` -> an actual newline) before
 * use. This is unambiguous — genuine PEM content produced by any normal
 * certificate export already contains real newlines, so a value with real
 * newlines is left untouched, and this branch only ever fires on the
 * specific "flattened by a UI" shape it exists to fix.
 *
 * TRUNCATION: a value that starts with a genuine `-----BEGIN CERTIFICATE-----`
 * header but was cut short before reaching `-----END CERTIFICATE-----` — a
 * paste dropped its last line, or hit a length limit in some UI's env-var
 * field — is still detected as PEM by PEM_HEADER and handed to Node's TLS
 * layer as-is. That fails, but with an OpenSSL ASN.1/PEM decode error that
 * names neither "Netlify" nor "truncated": an operator gets a cryptic
 * parser error with no hint of the actual, mundane cause, on the one
 * variable (DATABASE_SSL_ROOT_CERT) this file already goes out of its way
 * to diagnose clearly for the sibling escaped-newline failure above. This
 * is not a fail-open — Node never falls back to the system trust store
 * once `ca` is set, truncated or not — it is purely a diagnosability gap.
 * So: any detected-PEM value missing the closing `-----END CERTIFICATE-----`
 * marker throws here, naming truncation as the likely cause, instead of
 * reaching postgres.js/Node's TLS layer at all.
 */
export function resolveCaFile(options: ConnectionOptions): void {
  if (options.ssl && typeof options.ssl === 'object' && 'ca' in options.ssl) {
    const raw = (options.ssl as { ca: string }).ca;
    let ca: string;
    if (PEM_HEADER.test(raw)) {
      ca = raw.includes('\\n') && !raw.includes('\n') ? raw.replace(/\\n/g, '\n') : raw;
      if (!ca.includes(PEM_FOOTER)) {
        throw new Error(
          'DATABASE_SSL_ROOT_CERT looks like inline PEM (it starts with '
          + '"-----BEGIN CERTIFICATE-----") but never reaches a closing '
          + `"${PEM_FOOTER}" marker. This is almost always a truncated paste — `
          + "a UI's length limit or a dropped final line — not a genuine "
          + 'certificate. Re-paste the full PEM content, from the BEGIN line '
          + 'through the END line inclusive.',
        );
      }
    } else {
      ca = readFileSync(raw, 'utf8');
    }
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
