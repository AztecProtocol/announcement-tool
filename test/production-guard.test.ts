import { describe, it, expect } from 'vitest';
import { checkEnvironment, checksApply } from '../src/core/production-guard.js';

const prod = {
  nodeEnv: 'production',
  deployTarget: 'vm' as const,
  hostname: '127.0.0.1',
  publicBaseUrl: 'https://announce.example.org',
};

const netlifyProd = {
  nodeEnv: 'production',
  deployTarget: 'netlify' as const,
  publicBaseUrl: 'https://announce.example.org',
  auth0Issuer: 'https://tenant.us.auth0.com/',
  auth0Audience: 'https://announce.example.org/api',
  auth0ClientSecret: 'a-client-secret',
  sessionSecret: 'x'.repeat(32),
  enabledChannels: 'discord,email',
};

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
    expect(checkEnvironment({ allowInsecureDev: '1' })).toEqual([]); // no deployTarget at all, still skipped
  });
});

describe('checkEnvironment — VM/Tailscale shape (deployTarget: "vm")', () => {
  it('accepts a correctly configured environment', () => {
    expect(checkEnvironment(prod)).toEqual([]);
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

  it('does not require Auth0 config', () => {
    expect(checkEnvironment(prod).some(p => p.includes('AUTH0'))).toBe(false);
  });

  it('applies when nodeEnv is "staging" — the regression this guard exists to close', () => {
    // NODE_ENV=staging next start would previously leave isProduction() false,
    // silently disabling every check while the app served admin traffic.
    const problems = checkEnvironment({ ...prod, nodeEnv: 'staging' });
    expect(problems).toEqual([]);
    expect(checkEnvironment({ ...prod, nodeEnv: 'staging', hostname: '0.0.0.0' })
      .some(p => p.includes('HOSTNAME'))).toBe(true);
  });
});

describe('checkEnvironment — Netlify/Auth0 shape (deployTarget: "netlify")', () => {
  it('accepts a correctly configured environment with no HOSTNAME set', () => {
    expect(checkEnvironment(netlifyProd)).toEqual([]);
  });

  it('does not require or check HOSTNAME at all', () => {
    expect(checkEnvironment({ ...netlifyProd, hostname: '0.0.0.0' })).toEqual([]);
    expect(checkEnvironment({ ...netlifyProd, hostname: undefined })).toEqual([]);
  });

  it('rejects a missing Auth0 issuer', () => {
    const problems = checkEnvironment({ ...netlifyProd, auth0Issuer: undefined });
    expect(problems.some(p => p.includes('AUTH0'))).toBe(true);
  });

  it('rejects a missing Auth0 audience', () => {
    const problems = checkEnvironment({ ...netlifyProd, auth0Audience: undefined });
    expect(problems.some(p => p.includes('AUTH0'))).toBe(true);
  });

  it('rejects both Auth0 vars missing', () => {
    const problems = checkEnvironment({ ...netlifyProd, auth0Issuer: undefined, auth0Audience: undefined });
    expect(problems.some(p => p.includes('AUTH0'))).toBe(true);
  });
});

describe('checkEnvironment — checks that apply in both shapes', () => {
  it('rejects ADMIN_EMAIL being set on the VM shape', () => {
    const problems = checkEnvironment({ ...prod, adminEmail: 'someone@example.com' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ADMIN_EMAIL');
  });

  it('rejects ADMIN_EMAIL being set on the Netlify shape', () => {
    const problems = checkEnvironment({ ...netlifyProd, adminEmail: 'someone@example.com' });
    expect(problems.some(p => p.includes('ADMIN_EMAIL'))).toBe(true);
  });

  it('rejects a missing or non-https PUBLIC_BASE_URL on the VM shape', () => {
    expect(checkEnvironment({ ...prod, publicBaseUrl: undefined })
      .some(p => p.includes('PUBLIC_BASE_URL'))).toBe(true);
    expect(checkEnvironment({ ...prod, publicBaseUrl: 'http://announce.example.org' })
      .some(p => p.includes('PUBLIC_BASE_URL'))).toBe(true);
  });

  it('rejects a missing or non-https PUBLIC_BASE_URL on the Netlify shape', () => {
    expect(checkEnvironment({ ...netlifyProd, publicBaseUrl: undefined })
      .some(p => p.includes('PUBLIC_BASE_URL'))).toBe(true);
    expect(checkEnvironment({ ...netlifyProd, publicBaseUrl: 'http://announce.example.org' })
      .some(p => p.includes('PUBLIC_BASE_URL'))).toBe(true);
  });

  it('reports every problem at once on the VM shape, not just the first', () => {
    const problems = checkEnvironment({
      nodeEnv: 'production', deployTarget: 'vm', adminEmail: 'x@example.com', hostname: '0.0.0.0', publicBaseUrl: undefined,
    });
    expect(problems).toHaveLength(3);
  });

  it('reports every problem at once on the Netlify shape, not just the first', () => {
    const problems = checkEnvironment({
      nodeEnv: 'production',
      deployTarget: 'netlify',
      adminEmail: 'x@example.com',
      publicBaseUrl: undefined,
      auth0Issuer: undefined,
      auth0Audience: undefined,
      sessionSecret: undefined,
      auth0ClientSecret: undefined,
      enabledChannels: undefined,
    });
    expect(problems).toHaveLength(6);
  });
});

describe('checkEnvironment — Netlify shape: ENABLED_CHANNELS', () => {
  // Before this guard existed, an unset ENABLED_CHANNELS on Netlify meant
  // "all five" (the same default the VM shape uses), which built a Signal
  // adapter on a host with no signal-cli sidecar to reach. Every delivery
  // through it fails, burns MAX_ATTEMPTS retries, reaches 'exhausted', and
  // raises a health alert — the exact failure src/core/enabled-channels.ts
  // was written to prevent. Nothing else enforced the variable, so the guard
  // has to.

  it('rejects an unset ENABLED_CHANNELS on the Netlify shape', () => {
    const problems = checkEnvironment({ ...netlifyProd, enabledChannels: undefined });
    expect(problems.some(p => p.includes('ENABLED_CHANNELS'))).toBe(true);
  });

  it('rejects a blank ENABLED_CHANNELS on the Netlify shape', () => {
    const problems = checkEnvironment({ ...netlifyProd, enabledChannels: '   ' });
    expect(problems.some(p => p.includes('ENABLED_CHANNELS'))).toBe(true);
  });

  it('accepts a Netlify-safe list with no Signal', () => {
    const problems = checkEnvironment({ ...netlifyProd, enabledChannels: 'discord,email' });
    expect(problems.some(p => p.includes('ENABLED_CHANNELS'))).toBe(false);
  });

  it('rejects an ENABLED_CHANNELS that includes signal, because Netlify has no signal-cli sidecar', () => {
    const problems = checkEnvironment({ ...netlifyProd, enabledChannels: 'discord,signal' });
    expect(problems.some(p => p.includes('ENABLED_CHANNELS'))).toBe(true);
  });

  it('rejects a typo rather than throwing — a bad value must surface as a refusal to start', () => {
    expect(() => checkEnvironment({ ...netlifyProd, enabledChannels: 'discord,emial' }))
      .not.toThrow();
    const problems = checkEnvironment({ ...netlifyProd, enabledChannels: 'discord,emial' });
    expect(problems.some(p => p.includes('ENABLED_CHANNELS'))).toBe(true);
  });

  it('does not check ENABLED_CHANNELS on the VM shape — unset still means all five there', () => {
    const problems = checkEnvironment({ ...prod, enabledChannels: undefined });
    expect(problems.some(p => p.includes('ENABLED_CHANNELS'))).toBe(false);
  });
});

describe('checkEnvironment — Netlify shape: SESSION_SECRET and AUTH0_CLIENT_SECRET', () => {
  it('rejects a missing SESSION_SECRET', () => {
    const problems = checkEnvironment({ ...netlifyProd, sessionSecret: undefined });
    expect(problems.some(p => p.includes('SESSION_SECRET'))).toBe(true);
  });

  it('rejects a SESSION_SECRET shorter than 32 characters', () => {
    const problems = checkEnvironment({ ...netlifyProd, sessionSecret: 'x'.repeat(31) });
    expect(problems.some(p => p.includes('SESSION_SECRET'))).toBe(true);
  });

  it('accepts a SESSION_SECRET of exactly 32 characters', () => {
    const problems = checkEnvironment({ ...netlifyProd, sessionSecret: 'x'.repeat(32) });
    expect(problems.some(p => p.includes('SESSION_SECRET'))).toBe(false);
  });

  it('rejects a missing AUTH0_CLIENT_SECRET', () => {
    const problems = checkEnvironment({ ...netlifyProd, auth0ClientSecret: undefined });
    expect(problems.some(p => p.includes('AUTH0_CLIENT_SECRET'))).toBe(true);
  });

  it('does not check SESSION_SECRET or AUTH0_CLIENT_SECRET on the VM shape', () => {
    // The regression that matters: main's deployment shape must not be
    // affected by checks that only make sense for the browser login flow.
    expect(checkEnvironment(prod)).toEqual([]);
    expect(checkEnvironment({ ...prod, sessionSecret: undefined, auth0ClientSecret: undefined })).toEqual([]);
  });
});

describe('checkEnvironment — ambiguous or unset deployment shape fails closed', () => {
  it('rejects when deployTarget is entirely unset, even with otherwise-valid VM config', () => {
    const problems = checkEnvironment({
      nodeEnv: 'production', hostname: '127.0.0.1', publicBaseUrl: 'https://announce.example.org',
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some(p => p.includes('DEPLOY_TARGET'))).toBe(true);
  });

  it('rejects an unrecognized deployTarget value', () => {
    const problems = checkEnvironment({
      ...prod, deployTarget: 'staging' as unknown as 'vm',
    });
    expect(problems.some(p => p.includes('DEPLOY_TARGET'))).toBe(true);
  });

  it('does not silently pass with an unset shape — never skips both checks', () => {
    const problems = checkEnvironment({ publicBaseUrl: 'https://announce.example.org' });
    expect(problems.length).toBeGreaterThan(0);
  });
});
