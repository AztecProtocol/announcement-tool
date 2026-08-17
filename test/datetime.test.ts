import { describe, it, expect } from 'vitest';
import { utcInputToIso, isoToUtcInput } from '../src/core/datetime.js';

describe('utcInputToIso', () => {
  it('treats the entered wall-clock time as UTC', () => {
    expect(utcInputToIso('2026-08-28T14:00')).toBe('2026-08-28T14:00:00.000Z');
  });

  it('accepts a seconds component', () => {
    expect(utcInputToIso('2026-08-28T14:00:30')).toBe('2026-08-28T14:00:30.000Z');
  });

  it('returns undefined for empty input', () => {
    expect(utcInputToIso('')).toBeUndefined();
  });

  it('returns undefined for unparseable input', () => {
    expect(utcInputToIso('not a date')).toBeUndefined();
  });

  it('produces the same instant regardless of host timezone, by construction', () => {
    // Date.UTC(...) ignores process.env.TZ entirely, unlike `new Date(value)`
    // which parses in the local zone. Asserting the exact ISO output for a
    // fixed input is timezone-independent by construction: it would fail if
    // the implementation reverted to `new Date(value)` on any host whose
    // local zone isn't UTC, without relying on mutating process.env.TZ
    // mid-test (which doesn't reliably re-init the date subsystem in an
    // already-running Node process).
    expect(utcInputToIso('2026-08-28T14:00')).toBe('2026-08-28T14:00:00.000Z');
  });
});

describe('isoToUtcInput', () => {
  it('round-trips through utcInputToIso', () => {
    const v = '2026-08-28T14:00';
    expect(isoToUtcInput(utcInputToIso(v))).toBe(v);
  });

  it('returns an empty string when unset', () => {
    expect(isoToUtcInput(undefined)).toBe('');
  });
});
