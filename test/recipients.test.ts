import { describe, it, expect } from 'vitest';
import { parseRecipients } from '../src/core/recipients.js';

describe('parseRecipients', () => {
  it('splits on commas, trims, drops empties and duplicates, keeps order', () => {
    expect(parseRecipients('a@x.org, b@y.org,,a@x.org ,')).toEqual(['a@x.org', 'b@y.org']);
  });
  it('returns a single address as a one-element list', () => {
    expect(parseRecipients('ops@aztec.foundation')).toEqual(['ops@aztec.foundation']);
  });
  it('returns [] for undefined, empty and whitespace-only input', () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(' , ')).toEqual([]);
  });
});
