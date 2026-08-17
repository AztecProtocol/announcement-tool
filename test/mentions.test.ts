import { describe, it, expect } from 'vitest';
import { findMentions } from '../src/core/mentions.js';

describe('findMentions', () => {
  it('finds @everyone', () => {
    expect(findMentions('Please read @everyone')).toEqual(['@everyone']);
  });

  it('finds @here', () => {
    expect(findMentions('@here upgrade now')).toEqual(['@here']);
  });

  it('finds a role id mention', () => {
    expect(findMentions('ping <@&12345> please')).toEqual(['<@&12345>']);
  });

  it('finds a user id mention', () => {
    expect(findMentions('ask <@98765>')).toEqual(['<@98765>']);
  });

  it('reports each distinct mention once, in order', () => {
    expect(findMentions('@here and @everyone and @here again'))
      .toEqual(['@here', '@everyone']);
  });

  it('returns an empty array when there are none', () => {
    expect(findMentions('A normal body with an email ops@example.com')).toEqual([]);
  });

  it('does not match an email address', () => {
    expect(findMentions('write to ops@everyone.example.com')).toEqual([]);
  });

  it('matches a mention at the very start of the body', () => {
    expect(findMentions('@everyone please read this')).toEqual(['@everyone']);
  });

  it('matches a mention at the very end of the body', () => {
    expect(findMentions('please read this @everyone')).toEqual(['@everyone']);
  });

  it('matches @everyone inside a code span (no special-casing for code fences)', () => {
    expect(findMentions('run `notify @everyone` in the console')).toEqual(['@everyone']);
  });

  it('does not match @everyone appearing inside a URL path segment', () => {
    // Same false-positive class as the email case: an ordinary link in an
    // announcement body should not trip the warning.
    expect(findMentions('see https://example.com/@everyone/status')).toEqual([]);
  });

  it('matches @everyone followed by a comma mid-sentence', () => {
    expect(findMentions('Please upgrade, @everyone')).toEqual(['@everyone']);
  });

  it('does not match a different word that merely starts with @everyone', () => {
    expect(findMentions('@everyonesomething is not a mention')).toEqual([]);
  });

  it('does not match a different word that merely starts with @here', () => {
    expect(findMentions('@hereafter is not a mention')).toEqual([]);
  });
});
