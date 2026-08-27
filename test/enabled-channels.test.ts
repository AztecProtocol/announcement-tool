import { describe, it, expect, afterEach } from 'vitest';
import {
  parseEnabledChannels, enabledChannels, isChannelEnabled, resetEnabledChannelsCache,
} from '../src/core/enabled-channels.js';

describe('parseEnabledChannels', () => {
  it('returns every channel when unset', () => {
    expect(parseEnabledChannels(undefined).sort())
      .toEqual(['discord', 'email', 'signal', 'telegram', 'webhook']);
  });

  it('returns every channel when the value is only whitespace', () => {
    // An operator who writes ENABLED_CHANNELS= in a .env file means "I did not
    // decide", not "disable everything". Disabling everything silently would
    // make a publish succeed while reaching nobody.
    expect(parseEnabledChannels('   ').sort())
      .toEqual(['discord', 'email', 'signal', 'telegram', 'webhook']);
  });

  it('parses a comma-separated list', () => {
    expect(parseEnabledChannels('discord,email')).toEqual(['discord', 'email']);
  });

  it('tolerates spaces, blank entries and mixed case', () => {
    expect(parseEnabledChannels(' Discord , ,EMAIL ')).toEqual(['discord', 'email']);
  });

  it('deduplicates', () => {
    expect(parseEnabledChannels('discord,discord')).toEqual(['discord']);
  });

  it('returns zero channels for a value of only commas', () => {
    // Pinning CURRENT behaviour, not endorsing it: every part of ',,,' is a
    // blank entry, which the loop above skips, so this returns [] rather
    // than falling back to ALL the way undefined/blank-string does. A
    // publish would then succeed while reaching nobody, with no error at
    // startup or at publish time. A future change may decide this should
    // refuse instead (like an unrecognised channel name does) — if that
    // happens, update this test rather than treating its failure as a
    // regression.
    expect(parseEnabledChannels(',,,')).toEqual([]);
  });

  it('throws on an unrecognised channel rather than ignoring it', () => {
    // A typo must not silently disable a channel the operator believed was on.
    expect(() => parseEnabledChannels('discord,slak'))
      .toThrow(/unknown channel "slak"/i);
  });

  it('names every valid channel in the error, so the fix is obvious', () => {
    expect(() => parseEnabledChannels('nope')).toThrow(/discord/);
  });
});

describe('enabledChannels', () => {
  afterEach(() => {
    delete process.env.ENABLED_CHANNELS;
    resetEnabledChannelsCache();
  });

  it('reads the environment', () => {
    process.env.ENABLED_CHANNELS = 'webhook';
    resetEnabledChannelsCache();
    expect(enabledChannels()).toEqual(['webhook']);
    expect(isChannelEnabled('webhook')).toBe(true);
    expect(isChannelEnabled('signal')).toBe(false);
  });

  it('memoises, so a mid-process env change does not half-apply', () => {
    process.env.ENABLED_CHANNELS = 'webhook';
    resetEnabledChannelsCache();
    expect(enabledChannels()).toEqual(['webhook']);
    process.env.ENABLED_CHANNELS = 'discord';
    expect(enabledChannels()).toEqual(['webhook']);
  });
});
