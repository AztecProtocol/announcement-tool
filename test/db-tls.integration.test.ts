import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { connect } from '../src/db/connect.js';

/**
 * Proves TLS against a REAL Postgres, not just that buildConnectionOptions
 * shapes an options object correctly (test/db-connect.test.ts covers that
 * without a network or filesystem). Requires the db-tls docker-compose
 * service and infra/dev/gen-test-certs.sh's output — see docker-compose.dev.yml.
 *
 * Skips cleanly when the fixture is absent so a normal `npx vitest run`
 * (CI, or any developer who hasn't generated certs) is unaffected.
 */
const CERTS_DIR = path.resolve(__dirname, '../infra/dev/certs');
const CA_PATH = path.join(CERTS_DIR, 'ca.crt');
const WRONG_CA_PATH = path.join(CERTS_DIR, 'wrong-ca.crt');
const TLS_URL = 'postgres://announce:announce@localhost:5500/announce';

const ready = existsSync(CA_PATH) && existsSync(WRONG_CA_PATH);

describe.skipIf(!ready)('postgres TLS', () => {
  it('connects with verify-full against the test CA', async () => {
    const sql = connect({ databaseUrl: TLS_URL, sslMode: 'verify-full', sslRootCert: CA_PATH });
    try {
      expect((await sql`select 1 as ok`)[0].ok).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('REFUSES a server whose certificate the CA did not sign', async () => {
    // This is the assertion that matters. If it passes when it should not,
    // verify-full is decorative and the exposed port has no real protection.
    const sql = connect({ databaseUrl: TLS_URL, sslMode: 'verify-full', sslRootCert: WRONG_CA_PATH });
    await expect(sql`select 1`).rejects.toThrow();
    await sql.end().catch(() => {});
  });
});
