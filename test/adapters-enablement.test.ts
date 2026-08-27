import { describe, it, expect, afterEach } from 'vitest';
import { buildAdapters } from '../src/worker/adapters.js';
import { resetEnabledChannelsCache } from '../src/core/enabled-channels.js';

const fakeSql = {} as never;
const fakeSender = {} as never;

describe('buildAdapters default channel set', () => {
  afterEach(() => {
    delete process.env.ENABLED_CHANNELS;
    resetEnabledChannelsCache();
  });

  it('builds every adapter when the variable is unset', () => {
    resetEnabledChannelsCache();
    expect(Object.keys(buildAdapters(fakeSql, fakeSender)).sort())
      .toEqual(['discord', 'email', 'signal', 'telegram', 'webhook']);
  });

  it('builds only the enabled adapters', () => {
    process.env.ENABLED_CHANNELS = 'discord,email';
    resetEnabledChannelsCache();
    expect(Object.keys(buildAdapters(fakeSql, fakeSender)).sort())
      .toEqual(['discord', 'email']);
  });

  it('still honours an explicit list argument, which overrides the variable', () => {
    // The explicit argument stays supported so a test or a one-off script can
    // build a narrow map without touching process.env.
    process.env.ENABLED_CHANNELS = 'discord,email';
    resetEnabledChannelsCache();
    expect(Object.keys(buildAdapters(fakeSql, fakeSender, ['webhook']))).toEqual(['webhook']);
  });
});
