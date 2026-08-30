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
  const options: ConnectionOptions = { url };

  switch (env.sslMode) {
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
 * Builds a connection with the given env, applying `max` on top of whatever
 * buildConnectionOptions resolved. `max` is deliberately a separate argument
 * rather than part of DbEnv: pool size is tuned per process (web, worker,
 * the Netlify tick function each have their own value), not something to
 * centralise alongside the connection target and TLS settings.
 */
export function connect(env: DbEnv = {}, max?: number): Sql {
  const options = buildConnectionOptions(env);
  const { url, ...rest } = options;
  if (rest.ssl && typeof rest.ssl === 'object' && 'ca' in rest.ssl) {
    // buildConnectionOptions validated the path but left the file unread so
    // it stays pure; read the real CA bundle now, right before connecting.
    const ca = readFileSync((rest.ssl as { ca: string }).ca, 'utf8');
    rest.ssl = { ...rest.ssl, ca };
  }
  return postgres(url ?? DEFAULT_URL, { ...rest, ...(max === undefined ? {} : { max }) });
}

export function dbEnvFromProcessEnv(): DbEnv {
  return {
    databaseUrl: process.env.DATABASE_URL,
    sslMode: process.env.DATABASE_SSL_MODE,
    sslRootCert: process.env.DATABASE_SSL_ROOT_CERT,
  };
}
