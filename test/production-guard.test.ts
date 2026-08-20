import { describe, it, expect } from 'vitest';
import { checkEnvironment, isProduction } from '../src/core/production-guard.js';

const prod = { nodeEnv: 'production', hostname: '127.0.0.1', publicBaseUrl: 'https://announce.example.org' };

describe('isProduction', () => {
  it('is true only for exactly "production"', () => {
    expect(isProduction({ nodeEnv: 'production' })).toBe(true);
    expect(isProduction({ nodeEnv: 'development' })).toBe(false);
    expect(isProduction({ nodeEnv: 'Production' })).toBe(false);
    expect(isProduction({})).toBe(false);
  });
});

describe('checkEnvironment in development', () => {
  it('never complains, whatever is set', () => {
    expect(checkEnvironment({})).toEqual([]);
    expect(checkEnvironment({ nodeEnv: 'development', adminEmail: 'dev@example.com' })).toEqual([]);
    expect(checkEnvironment({ nodeEnv: 'development', hostname: '0.0.0.0' })).toEqual([]);
  });
});

describe('checkEnvironment in production', () => {
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
});
