import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/env.js';

describe('loadEnv', () => {
  it('loads KEY=VALUE, strips quotes, skips comments/broken lines, never overrides existing env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(dir, '.env'),
      '# a comment\nENV_TEST_A=hello\nENV_TEST_QUOTED="with spaces"\nENV_TEST_EXISTING=from-file\n\nBROKENLINE\n=nokey\n');
    process.env.ENV_TEST_EXISTING = 'from-shell';
    delete process.env.ENV_TEST_A;
    delete process.env.ENV_TEST_QUOTED;

    loadEnv(dir);

    expect(process.env.ENV_TEST_A).toBe('hello');
    expect(process.env.ENV_TEST_QUOTED).toBe('with spaces');
    expect(process.env.ENV_TEST_EXISTING).toBe('from-shell'); // shell wins over file

    delete process.env.ENV_TEST_A;
    delete process.env.ENV_TEST_QUOTED;
    delete process.env.ENV_TEST_EXISTING;
  });

  it('is a silent no-op when no .env exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    expect(() => loadEnv(dir)).not.toThrow();
  });
});
