import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildConnectionOptions, connect, resolveCaFile, normalizePem, type ConnectionOptions } from '../src/db/connect.js';

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
    // `?sslmode=require`, which is the same half-guarantee this module
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

  it('rejects sslmode in a multi-host DATABASE_URL, which the WHATWG URL parser cannot parse at all', () => {
    // postgres.js accepts postgres://u:p@h1:5432,h2:5432/db (a normal
    // Postgres HA form) by rewriting it to its first host before parsing --
    // `new URL()` on the raw string throws instead. A version of this check
    // that only tried `new URL()` and silently skipped validation on failure
    // would let exactly this combination through: real syntax, confirmed to
    // reach postgres.js's own sslmode handling, not a hypothetical case.
    expect(() => buildConnectionOptions({
      databaseUrl: 'postgres://u:p@h1:5432,h2:5432/db?sslmode=require',
    })).toThrow(/sslmode/);
  });

  it('rejects sslrootcert in a multi-host DATABASE_URL', () => {
    expect(() => buildConnectionOptions({
      databaseUrl: 'postgres://u:p@h1:5432,h2:5432/db?sslrootcert=system',
    })).toThrow(/sslrootcert/);
  });

  it('does not false-positive on a percent-encoded "sslmode=" inside the password', () => {
    // The regex backstop requires a literal, unescaped `?` or `&` delimiter
    // immediately before sslmode=/sslrootcert=. A percent-encoded occurrence
    // inside credentials (%3Fsslmode%3D) has no literal delimiter character,
    // so it must not trip the check -- a later reader must not "simplify" the
    // delimiter requirement away and reintroduce false positives on ordinary
    // passwords.
    expect(buildConnectionOptions({
      databaseUrl: 'postgres://u:p%3Fsslmode%3Drequire@h/db',
    }).ssl).toBeUndefined();
  });
});

describe('resolveCaFile', () => {
  // Real PEM structure is irrelevant here -- resolveCaFile only decides
  // path-vs-inline by the header text and never parses the certificate
  // itself (that happens later, inside Node's TLS layer / postgres.js).
  // Using a fake-but-well-formed-looking body keeps these tests fast and
  // filesystem/network-free; db-tls.integration.test.ts proves a real PEM
  // negotiates TLS against a real server.
  const FAKE_PEM = '-----BEGIN CERTIFICATE-----\nMIIFAKECERTDATA\n-----END CERTIFICATE-----\n';

  it('uses inline PEM content directly, without touching the filesystem', () => {
    // A serverless Netlify function has no filesystem to place a CA bundle
    // on -- DATABASE_SSL_ROOT_CERT must be usable as a pasted value, not
    // only as a path, or verify-full (mandatory once the database is
    // internet-reachable) has no satisfiable configuration on that shape.
    const options: ConnectionOptions = { ssl: { ca: FAKE_PEM, rejectUnauthorized: true } };
    resolveCaFile(options);
    expect((options.ssl as { ca: string }).ca).toBe(FAKE_PEM);
  });

  it('still reads a file path exactly as before, for the VM and local dev shapes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'announce-ca-'));
    const file = path.join(dir, 'ca.pem');
    try {
      writeFileSync(file, FAKE_PEM, 'utf8');
      const options: ConnectionOptions = { ssl: { ca: file, rejectUnauthorized: true } };
      resolveCaFile(options);
      expect((options.ssl as { ca: string }).ca).toBe(FAKE_PEM);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unescapes literal \\n sequences in inline PEM content pasted through a UI that flattened real newlines', () => {
    // A well-known way certificates get mangled: some web UIs (or tooling
    // that round-trips env vars through single-line JSON/shell strings)
    // turn real newlines into the two literal characters `\` and `n`. The
    // PEM header is still intact (no backslash-n before the dashes), so
    // this is still detected as PEM, but the raw value would otherwise
    // reach postgres.js/Node's TLS layer as one unparseable line.
    const flattened = FAKE_PEM.replace(/\n/g, '\\n');
    expect(flattened).not.toContain('\n');
    const options: ConnectionOptions = { ssl: { ca: flattened, rejectUnauthorized: true } };
    resolveCaFile(options);
    expect((options.ssl as { ca: string }).ca).toBe(FAKE_PEM);
  });

  it('does not unescape a literal \\n when real newlines are already present, only re-canonicalizes the block', () => {
    // Real newlines already present is proof the value was NOT flattened by
    // a UI -- unescaping in that case would corrupt a certificate that
    // happens to have been issued with, e.g., a comment or subject field
    // containing a literal backslash-n. Only fire the unescape path when
    // there is no real newline at all. The trailing literal `\n` here sits
    // outside any BEGIN/END block, so canonicalization (which now always
    // runs on inline PEM) drops it along with the rest of the non-PEM
    // trailer -- it was never part of the certificate.
    const mixed = `${FAKE_PEM}\\n`;
    const options: ConnectionOptions = { ssl: { ca: mixed, rejectUnauthorized: true } };
    resolveCaFile(options);
    expect((options.ssl as { ca: string }).ca).toBe(FAKE_PEM);
  });

  it('fails loudly, naming truncation, for a PEM value cut short before its END marker', () => {
    // A UI's env-var length limit, or a paste that dropped its last line, is
    // a realistic way to lose the closing marker while keeping the opening
    // one intact -- PEM_HEADER alone would still call this "PEM" and hand
    // it to Node's TLS layer, which fails with an opaque ASN.1 decode error
    // naming neither Netlify nor truncation. This must throw here instead,
    // with a message an operator can act on directly.
    const truncated = '-----BEGIN CERTIFICATE-----\nMIIFAKECERTDATA\n';
    const options: ConnectionOptions = { ssl: { ca: truncated, rejectUnauthorized: true } };
    expect(() => resolveCaFile(options)).toThrow(/truncat/i);
  });

  it('fails loudly, naming truncation, for an escaped-newline PEM cut short before its END marker', () => {
    // The truncation check must run on the value AFTER unescaping, not
    // before -- an escaped-newline paste that was also truncated should
    // still be caught, not slip through because the raw string doesn't
    // literally contain the footer text on its own line.
    const truncated = '-----BEGIN CERTIFICATE-----\\nMIIFAKECERTDATA\\n';
    const options: ConnectionOptions = { ssl: { ca: truncated, rejectUnauthorized: true } };
    expect(() => resolveCaFile(options)).toThrow(/truncat/i);
  });

  it('fails loudly for a value that is neither valid PEM nor an existing file', () => {
    // A bad path (typo, wrong mount, a value that is actually meant to be
    // pasted PEM but got truncated before the BEGIN header survived) must
    // not silently produce an empty/undefined ca and connect unverified --
    // readFileSync throwing ENOENT is the loud failure this needs.
    const options: ConnectionOptions = { ssl: { ca: '/definitely/does/not/exist/ca.pem', rejectUnauthorized: true } };
    expect(() => resolveCaFile(options)).toThrow(/ENOENT|no such file/i);
  });

  it('is a no-op when there is no ssl.ca to resolve', () => {
    const options: ConnectionOptions = {};
    expect(() => resolveCaFile(options)).not.toThrow();
    expect(options.ssl).toBeUndefined();
  });
});

describe('normalizePem', () => {
  // A real short self-signed certificate (P-256, CN=t), generated once with:
  //   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  //     -keyout /dev/null -subj /CN=t -days 1
  // Its canonical PEM is real 64-column output from OpenSSL, so tests that
  // assert "output equals this string" are asserting against genuine PEM
  // shape, not a hand-typed approximation of one.
  const CERT_A = '-----BEGIN CERTIFICATE-----\n'
    + 'MIIBbjCCAROgAwIBAgIUEhPzkIfJr2f1SuTlYGw53ztPjFQwCgYIKoZIzj0EAwIw\n'
    + 'DDEKMAgGA1UEAwwBdDAeFw0yNjA5MDQxNDQ4MDZaFw0yNjA5MDUxNDQ4MDZaMAwx\n'
    + 'CjAIBgNVBAMMAXQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATsqXZg6sDmIrRT\n'
    + 'b6Ei0OjtIlLE+OQjWKrZW6xRGnvacNLuzCpdLIwKYCJBQoQi5HZnGRMke4xIxG8W\n'
    + '/UK6ksAAo1MwUTAdBgNVHQ4EFgQUWi7y0PLijEPWVKoiZK0QQaELVvcwHwYDVR0j\n'
    + 'BBgwFoAUWi7y0PLijEPWVKoiZK0QQaELVvcwDwYDVR0TAQH/BAUwAwEB/zAKBggq\n'
    + 'hkjOPQQDAgNJADBGAiEAgAVHUGAP2Q9Tmou/sFU2d/B1MoRsa0DPb7wgMPZWwTQC\n'
    + 'IQCsMSLYGeyyElb86Z93Ds6Ax5huOsVjpV2KlLBlOr2VXQ==\n'
    + '-----END CERTIFICATE-----\n';

  it('leaves an already-canonical PEM unchanged', () => {
    expect(normalizePem(CERT_A)).toBe(CERT_A);
  });

  it('repairs a PEM whose newlines were replaced by single spaces', () => {
    const flattened = CERT_A.trim().replace(/\n/g, ' ');
    expect(normalizePem(flattened)).toBe(CERT_A);
  });

  it('repairs a PEM whose newlines were removed entirely, joining header/body/footer', () => {
    const flattened = CERT_A.trim().replace(/\n/g, '');
    expect(normalizePem(flattened)).toBe(CERT_A);
  });

  it('repairs a PEM with literal backslash-n sequences instead of real newlines', () => {
    const flattened = CERT_A.trim().replace(/\n/g, '\\n');
    expect(normalizePem(flattened)).toBe(CERT_A);
  });

  it('repairs two certificates concatenated with damaged whitespace into two canonical blocks in order', () => {
    const CERT_B = CERT_A.replace('MIIBbjCC', 'MIIBbjCD');
    const bundle = CERT_A.trim().replace(/\n/g, ' ') + ' ' + CERT_B.trim().replace(/\n/g, '');
    expect(normalizePem(bundle)).toBe(CERT_A + CERT_B);
  });

  it('throws the truncated-paste error when a BEGIN marker has no matching END marker', () => {
    const truncated = '-----BEGIN CERTIFICATE-----\nMIIBbjCC\n';
    expect(() => normalizePem(truncated)).toThrow(/truncat/i);
  });

  it('produces output that Node parses as a valid X509 certificate', () => {
    const flattened = CERT_A.trim().replace(/\n/g, ' ');
    const normalized = normalizePem(flattened);
    expect(() => new X509Certificate(normalized)).not.toThrow();
    expect(new X509Certificate(normalized).subject).toBe('CN=t');
  });
});

describe('connect', () => {
  // Each of the four call sites keeps its own tuned pool size (web 5,
  // worker 4, tick 4) rather than being unified — that had zero
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
