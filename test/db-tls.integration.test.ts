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
  it('connects with verify-full against the test CA, over an actually-encrypted session', async () => {
    const sql = connect({ databaseUrl: TLS_URL, sslMode: 'verify-full', sslRootCert: CA_PATH });
    try {
      expect((await sql`select 1 as ok`)[0].ok).toBe(1);
      // A round-trip alone doesn't prove the session is encrypted — a
      // plaintext fallback would answer `select 1` just as happily. Ask
      // Postgres directly whether the current backend's connection is TLS.
      const [{ ssl }] = await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
      expect(ssl).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it('REFUSES a server whose certificate the CA did not sign', async () => {
    // This is the assertion that matters. If it passes when it should not,
    // verify-full is decorative and the exposed port has no real protection.
    const sql = connect({ databaseUrl: TLS_URL, sslMode: 'verify-full', sslRootCert: WRONG_CA_PATH });
    // A bare .rejects.toThrow() would also accept ECONNREFUSED from a
    // stopped container, a wrong port, or a timeout — none of which prove
    // verify-full is doing anything. Assert on the specific TLS failure code
    // instead of the human-readable message, which can change between
    // Node/OpenSSL versions while the code is stable. Confirmed live: the
    // thrown error is a plain Error with `code` as an own top-level
    // property (no wrapping, no `cause`) — see task-2-report.md.
    await expect(sql`select 1`).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    await sql.end().catch(() => {});
  });
});
