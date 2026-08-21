import { describe, it, expect } from 'vitest';
import { tickSecretMatches } from '../src/core/tick-auth.js';

describe('tickSecretMatches', () => {
  it('rejects when configured secret is undefined', () => {
    expect(tickSecretMatches(undefined, 'anything')).toBe(false);
  });

  it('rejects when configured secret is an empty string', () => {
    expect(tickSecretMatches('', 'anything')).toBe(false);
  });

  it('rejects when presented value is null', () => {
    expect(tickSecretMatches('correct-secret', null)).toBe(false);
  });

  it('rejects when presented value is an empty string', () => {
    expect(tickSecretMatches('correct-secret', '')).toBe(false);
  });

  it('accepts a correct match', () => {
    expect(tickSecretMatches('correct-secret', 'correct-secret')).toBe(true);
  });

  it('rejects a wrong value of the same length', () => {
    expect(tickSecretMatches('correct-secret', 'wrong-value!!!')).toBe(false);
  });

  it('rejects a wrong value of a different length without throwing', () => {
    expect(() => tickSecretMatches('correct-secret', 'short')).not.toThrow();
    expect(tickSecretMatches('correct-secret', 'short')).toBe(false);
  });

  it('rejects a presented value much longer than configured, without throwing', () => {
    expect(() => tickSecretMatches('short', 'a-much-longer-presented-value')).not.toThrow();
    expect(tickSecretMatches('short', 'a-much-longer-presented-value')).toBe(false);
  });

  it('both unset/empty refuses rather than allowing', () => {
    expect(tickSecretMatches(undefined, null)).toBe(false);
    expect(tickSecretMatches('', '')).toBe(false);
  });
});
