import { describe, it, expect } from 'vitest';
import { buildConnectionOptions, connect } from '../src/db/connect.js';

describe('buildConnectionOptions', () => {
  it('defaults to the local dev database when DATABASE_URL is unset', () => {
    const o = buildConnectionOptions({});
    expect(o.url ?? o.host).toBeDefined();
  });

  it('does not enable TLS when no ssl mode is set', () => {
    // Local dev and the docker-compose network both talk plaintext over a
    // private network. Forcing TLS there would break every existing setup.
    expect(buildConnectionOptions({ databaseUrl: 'postgres://a:b@h/db' }).ssl).toBeUndefined();
  });

  it('rejects sslmode=require as insufficient', () => {
    // require encrypts but does NOT verify the server certificate, so it stops
    // a passive eavesdropper and not an active attacker. The credentials behind
    // this connection can post as the Foundation, so half a guarantee is a
    // misconfiguration, not a weaker option.
    expect(() => buildConnectionOptions({ databaseUrl: 'postgres://a:b@h/db', sslMode: 'require' }))
      .toThrow(/verify-full/);
  });

  it('enables verifying TLS for sslmode=verify-full', () => {
    const o = buildConnectionOptions({
      databaseUrl: 'postgres://a:b@h/db', sslMode: 'verify-full', sslRootCert: '/etc/ssl/ca.pem',
    });
    expect(o.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it('refuses verify-full without a CA bundle', () => {
    // Without a CA, "verify" silently falls back to the system trust store,
    // which may or may not contain the issuer. Failing loudly beats connecting
    // with an unverified guarantee the operator believes is verified.
    expect(() => buildConnectionOptions({
      databaseUrl: 'postgres://a:b@h/db', sslMode: 'verify-full',
    })).toThrow(/DATABASE_SSL_ROOT_CERT/);
  });

  it('rejects an unknown ssl mode rather than ignoring it', () => {
    expect(() => buildConnectionOptions({ databaseUrl: 'postgres://a:b@h/db', sslMode: 'yes' }))
      .toThrow(/DATABASE_SSL_MODE/);
  });

  it('treats an empty DATABASE_SSL_MODE as unset, not as a value to reject', () => {
    // Compose, the Netlify UI, and a bare `DATABASE_SSL_MODE=` in a .env file
    // all produce '' for "present but blank" routinely — that must behave
    // like the variable was never set, matching how ENABLED_CHANNELS treats
    // a blank value elsewhere (src/core/enabled-channels.ts).
    expect(buildConnectionOptions({ databaseUrl: 'postgres://a:b@h/db', sslMode: '' }).ssl)
      .toBeUndefined();
  });

  it('rejects sslmode in the DATABASE_URL query string even when DATABASE_SSL_MODE is unset', () => {
    // postgres.js's own parseOptions reads `?sslmode=` straight out of the
    // connection string and turns it into its `ssl` option — including
    // `?sslmode=require`, which is exactly the half-guarantee this module
    // exists to refuse. Without this check, an operator who writes the
    // connection string the way every Postgres tutorial does would bypass
    // every check above with no error.
    expect(() => buildConnectionOptions({ databaseUrl: 'postgres://a:b@h/db?sslmode=require' }))
      .toThrow(/sslmode/);
  });

  it('rejects sslrootcert in the DATABASE_URL query string', () => {
    // `?sslrootcert=system` silently becomes verify-full inside postgres.js,
    // bypassing DATABASE_SSL_ROOT_CERT's required-CA check the same way.
    expect(() => buildConnectionOptions({ databaseUrl: 'postgres://a:b@h/db?sslrootcert=system' }))
      .toThrow(/sslrootcert/);
  });

  it('rejects sslmode in the URL even when DATABASE_SSL_MODE=verify-full is also set correctly', () => {
    // Two competing sources of truth is the bug, not just an empty one being
    // wrong — the URL-embedded parameter must be refused regardless of what
    // the dedicated env vars say.
    expect(() => buildConnectionOptions({
      databaseUrl: 'postgres://a:b@h/db?sslmode=verify-full',
      sslMode: 'verify-full',
      sslRootCert: '/etc/ssl/ca.pem',
    })).toThrow(/sslmode/);
  });
});

describe('connect', () => {
  // The brief requires each of the four call sites keep its own tuned pool
  // size (web 5, worker 4, tick 4) rather than being unified — that had zero
  // test coverage. connect() builds the postgres.js client lazily/eagerly
  // depending on version, but the `max` option it was constructed with is
  // readable back off the returned Sql's options, which is enough to prove
  // the value was threaded through rather than dropped or hardcoded.
  it('passes max through unchanged for each call site\'s tuned pool size', async () => {
    for (const max of [5, 4, 1]) {
      const sql = connect({ databaseUrl: 'postgres://a:b@h/db' }, max);
      try {
        expect(sql.options.max).toBe(max);
      } finally {
        await sql.end({ timeout: 0 });
      }
    }
  });

  it('defaults to no max override when none is given', async () => {
    const sql = connect({ databaseUrl: 'postgres://a:b@h/db' });
    try {
      // postgres.js's own default (10), not undefined and not one of the
      // per-call-site tuned values — proves the `max` argument is optional
      // and additive rather than required.
      expect(sql.options.max).toBe(10);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
