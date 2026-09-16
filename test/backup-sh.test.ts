import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('scripts/backup.sh', () => {
  it('dumps privileges, so a restore keeps the announce_app grants', () => {
    const src = readFileSync(resolve(__dirname, '../scripts/backup.sh'), 'utf8');
    const dumpLine = src.split('\n').find((l) => l.startsWith('pg_dump'));
    expect(dumpLine).toBeDefined();
    expect(dumpLine).not.toContain('--no-privileges');
    expect(dumpLine).toContain('--no-owner');
  });
});
