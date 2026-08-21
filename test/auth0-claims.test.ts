import { describe, it, expect } from 'vitest';
import { emailFromClaims } from '../src/core/auth0-claims.js';

describe('emailFromClaims', () => {
  it('returns the email when it is present and verified', () => {
    expect(emailFromClaims({ email: 'publisher@example.com', email_verified: true }))
      .toBe('publisher@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(emailFromClaims({ email: '  publisher@example.com  ', email_verified: true }))
      .toBe('publisher@example.com');
  });

  // The four-eyes rule compares the confirmer's email to the requester's. An
  // unverified address means someone could register an address they do not own
  // and become a valid second approver.
  it('denies when email_verified is false', () => {
    expect(emailFromClaims({ email: 'publisher@example.com', email_verified: false }))
      .toBeUndefined();
  });

  it('denies when email_verified is missing entirely', () => {
    expect(emailFromClaims({ email: 'publisher@example.com' })).toBeUndefined();
  });

  it('denies when email_verified is truthy but not boolean true', () => {
    for (const v of ['true', 1, {}, [], 'yes']) {
      expect(emailFromClaims({ email: 'publisher@example.com', email_verified: v }))
        .toBeUndefined();
    }
  });

  it('denies when the email claim is missing', () => {
    expect(emailFromClaims({ email_verified: true })).toBeUndefined();
  });

  it('denies when the email is empty or whitespace only', () => {
    expect(emailFromClaims({ email: '', email_verified: true })).toBeUndefined();
    expect(emailFromClaims({ email: '   ', email_verified: true })).toBeUndefined();
    expect(emailFromClaims({ email: '\t\n ', email_verified: true })).toBeUndefined();
  });

  it('denies when the email claim is not a string', () => {
    for (const v of [123, null, undefined, {}, [], true]) {
      expect(emailFromClaims({ email: v, email_verified: true })).toBeUndefined();
    }
  });

  it('denies on a completely empty payload', () => {
    expect(emailFromClaims({})).toBeUndefined();
  });
});
