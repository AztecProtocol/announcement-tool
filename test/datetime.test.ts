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
    // local zone isn't UTC. This guards a different property than the TZ-
    // mutation test below: a future implementation that is correct for this
    // fixed literal but becomes TZ-sensitive through some other path (e.g.
    // a locale-aware parse branch) would still pass this test but fail that
    // one.
    expect(utcInputToIso('2026-08-28T14:00')).toBe('2026-08-28T14:00:00.000Z');
  });

  it('does not depend on the host timezone', () => {
    // The whole point: the same string must yield the same instant everywhere.
    const before = process.env.TZ;
    process.env.TZ = 'Asia/Tbilisi';
    const a = utcInputToIso('2026-08-28T14:00');
    process.env.TZ = 'America/Los_Angeles';
    const b = utcInputToIso('2026-08-28T14:00');
    process.env.TZ = before;
    expect(a).toBe(b);
  });

  it('rejects a day that rolls over (32 April -> would silently become 1 May)', () => {
    expect(utcInputToIso('2026-04-32T14:00')).toBeUndefined();
  });

  it('rejects a month that rolls over (month 13 -> would silently become next January)', () => {
    expect(utcInputToIso('2026-13-01T14:00')).toBeUndefined();
  });

  it('rejects an hour that rolls over (hour 25 -> would silently become next day 01:00)', () => {
    expect(utcInputToIso('2026-08-28T25:00')).toBeUndefined();
  });

  it('rejects 31 February in any year', () => {
    expect(utcInputToIso('2026-02-31T12:00')).toBeUndefined();
  });

  it('accepts a genuine leap day without over-rejecting', () => {
    expect(utcInputToIso('2028-02-29T12:00')).toBe('2028-02-29T12:00:00.000Z');
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
