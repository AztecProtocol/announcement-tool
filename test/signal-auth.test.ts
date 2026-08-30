import { describe, it, expect } from 'vitest';
import { signalAuthHeaders, SIGNAL_AUTH_HEADER } from '../src/core/signal-auth.js';

describe('signalAuthHeaders', () => {
  it('sends no auth header when no secret is configured', () => {
    expect(signalAuthHeaders(undefined)).toEqual({});
  });

  it('sends no auth header when the secret is blank', () => {
    expect(signalAuthHeaders('')).toEqual({});
    expect(signalAuthHeaders('   ')).toEqual({});
  });

  it('sends the shared secret when one is configured', () => {
    expect(signalAuthHeaders('s3cret')).toEqual({ [SIGNAL_AUTH_HEADER]: 's3cret' });
  });
});
