import { describe, it, expect } from 'vitest';
import { checkEnvironment, checksApply } from '../src/core/production-guard.js';

const prod = { nodeEnv: 'production', hostname: '127.0.0.1', publicBaseUrl: 'https://announce.example.org' };

describe('checksApply', () => {
  it('applies by default, whatever nodeEnv is', () => {
    expect(checksApply({})).toBe(true);
    expect(checksApply({ nodeEnv: 'production' })).toBe(true);
    expect(checksApply({ nodeEnv: 'development' })).toBe(true);
    expect(checksApply({ nodeEnv: 'staging' })).toBe(true);
    expect(checksApply({ nodeEnv: undefined })).toBe(true);
  });

  it('is skipped only by the exact opt-out value "1"', () => {
    expect(checksApply({ allowInsecureDev: '1' })).toBe(false);
    expect(checksApply({ allowInsecureDev: '0' })).toBe(true);
    expect(checksApply({ allowInsecureDev: 'true' })).toBe(true);
    expect(checksApply({ allowInsecureDev: '' })).toBe(true);
  });
});

describe('checkEnvironment with the insecure-dev opt-out', () => {
  it('never complains when ANNOUNCE_ALLOW_INSECURE_DEV=1, whatever else is set', () => {
    expect(checkEnvironment({ allowInsecureDev: '1' })).toEqual([]);
    expect(checkEnvironment({ nodeEnv: 'development', adminEmail: 'dev@example.com', allowInsecureDev: '1' })).toEqual([]);
    expect(checkEnvironment({ nodeEnv: 'development', hostname: '0.0.0.0', allowInsecureDev: '1' })).toEqual([]);
  });
});

describe('checkEnvironment applies regardless of NODE_ENV', () => {
  it('accepts a correctly configured environment', () => {
    expect(checkEnvironment(prod)).toEqual([]);
  });

  it('rejects ADMIN_EMAIL being set', () => {
    const problems = checkEnvironment({ ...prod, adminEmail: 'someone@example.com' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ADMIN_EMAIL');
  });

  it('accepts both loopback forms', () => {
    expect(checkEnvironment({ ...prod, hostname: '127.0.0.1' })).toEqual([]);
    expect(checkEnvironment({ ...prod, hostname: '::1' })).toEqual([]);
  });

  it('rejects a non-loopback HOSTNAME', () => {
    for (const hostname of ['0.0.0.0', '10.0.0.5', '::', 'announce.example.org']) {
      const problems = checkEnvironment({ ...prod, hostname });
      expect(problems.some(p => p.includes('HOSTNAME'))).toBe(true);
    }
  });

  it('rejects an unset HOSTNAME, because Next then binds every interface', () => {
    const problems = checkEnvironment({ ...prod, hostname: undefined });
    expect(problems.some(p => p.includes('HOSTNAME'))).toBe(true);
  });

  it('rejects a missing or non-https PUBLIC_BASE_URL', () => {
    expect(checkEnvironment({ ...prod, publicBaseUrl: undefined })
      .some(p => p.includes('PUBLIC_BASE_URL'))).toBe(true);
    expect(checkEnvironment({ ...prod, publicBaseUrl: 'http://announce.example.org' })
      .some(p => p.includes('PUBLIC_BASE_URL'))).toBe(true);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = checkEnvironment({
      nodeEnv: 'production', adminEmail: 'x@example.com', hostname: '0.0.0.0', publicBaseUrl: undefined,
    });
    expect(problems).toHaveLength(3);
  });

  it('applies when nodeEnv is "staging" — the regression this guard exists to close', () => {
    // NODE_ENV=staging next start would previously leave isProduction() false,
    // silently disabling every check while the app served admin traffic.
    const problems = checkEnvironment({ ...prod, nodeEnv: 'staging' });
    expect(problems).toEqual([]);
    expect(checkEnvironment({ nodeEnv: 'staging', hostname: '0.0.0.0' })
      .some(p => p.includes('HOSTNAME'))).toBe(true);
  });

  it('applies when nodeEnv is undefined', () => {
    const problems = checkEnvironment({ hostname: '0.0.0.0' });
    expect(problems.some(p => p.includes('HOSTNAME'))).toBe(true);
  });
});
