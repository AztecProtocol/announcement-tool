import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/send-alert.sh');

/** Runs send_alert with a fake curl on PATH; returns the JSON body curl received. */
function run(env: Record<string, string>, cwd?: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'send-alert-'));
  const out = join(dir, 'curl-args');
  // The fake curl writes every argument on its own line; the body follows "-d".
  writeFileSync(join(dir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(join(dir, 'curl'), 0o755);
  execFileSync('bash', ['-c', `log() { :; }; . "${SCRIPT}"; send_alert "subj" "body"`], {
    env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` },
    cwd,
  });
  const args = readFileSync(out, 'utf8').split('\n');
  return JSON.parse(args[args.indexOf('-d') + 1]!);
}

describe('scripts/send-alert.sh recipients', () => {
  it('brevo: one recipient entry per address, trimmed and de-duplicated', () => {
    const body = run({ ESP_PROVIDER: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM: 'f@x.org', ALERT_EMAIL_TO: 'a@x.org, b@y.org,,a@x.org' }) as { to: unknown };
    expect(body.to).toEqual([{ email: 'a@x.org' }, { email: 'b@y.org' }]);
  });
  it('resend: the list as-is', () => {
    const body = run({ ESP_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'f@x.org', ALERT_EMAIL_TO: 'a@x.org, b@y.org' }) as { to: unknown };
    expect(body.to).toEqual(['a@x.org', 'b@y.org']);
  });
  it('a single address still works', () => {
    const body = run({ ESP_PROVIDER: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM: 'f@x.org', ALERT_EMAIL_TO: 'ops@x.org' }) as { to: unknown };
    expect(body.to).toEqual([{ email: 'ops@x.org' }]);
  });
  it('an address of "*" is not pathname-expanded against files in the cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'send-alert-cwd-'));
    writeFileSync(join(dir, 'a@x.org'), '');
    const body = run(
      { ESP_PROVIDER: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM: 'f@x.org', ALERT_EMAIL_TO: '*, b@y.org' },
      dir,
    ) as { to: unknown };
    expect(body.to).toEqual([{ email: '*' }, { email: 'b@y.org' }]);
  });
});
