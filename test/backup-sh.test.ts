import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('scripts/backup.sh', () => {
  it('dumps privileges, so a restore keeps the announce_app grants', () => {
    const src = readFileSync(resolve(__dirname, '../scripts/backup.sh'), 'utf8');
    const dumpLine = src.split('\n').find((l) => l.startsWith('pg_dump'));
    expect(dumpLine).toBeDefined();
    expect(dumpLine).not.toContain('--no-privileges');
    expect(dumpLine).toContain('--no-owner');
  });

  it('refuses a BACKUP_S3_ENDPOINT without a scheme before touching the database, and the alert names the step', () => {
    const r = spawnSync('bash', [resolve(__dirname, '../scripts/backup.sh')], {
      env: {
        ...process.env,
        PGHOST: '127.0.0.1', PGPORT: '1', PGUSER: 'x', PGDATABASE: 'x', PGPASSWORD: 'x',
        BACKUP_ENCRYPTION_KEY: 'k', BACKUP_S3_BUCKET: 'b',
        BACKUP_S3_ENDPOINT: 'b.fsn1.your-objectstorage.com',
        ESP_PROVIDER: 'console',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BACKUP_S3_ENDPOINT must start with https://');
    expect(r.stderr).toContain('at step: config');
    expect(r.stderr).not.toContain('dumping');
  });
});
