import { describe, it, expect } from 'vitest';
import { buildConnectionOptions } from '../src/db/connect.js';

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
});
