import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_BASE_URL, publicBaseUrl } from '../src/core/public-base-url.js';

const saved = process.env.PUBLIC_BASE_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = saved;
});

describe('publicBaseUrl', () => {
  it('defaults to the production host and never ends with a slash', () => {
    delete process.env.PUBLIC_BASE_URL;
    expect(DEFAULT_PUBLIC_BASE_URL).toBe('https://announce.aztec.network');
    expect(publicBaseUrl()).toBe('https://announce.aztec.network');
  });

  it('reads PUBLIC_BASE_URL and strips trailing slashes', () => {
    process.env.PUBLIC_BASE_URL = 'https://example.test///';
    expect(publicBaseUrl()).toBe('https://example.test');
  });

  it('prefers an explicit override over the environment', () => {
    process.env.PUBLIC_BASE_URL = 'https://env.test';
    expect(publicBaseUrl('https://override.test/')).toBe('https://override.test');
  });
});
