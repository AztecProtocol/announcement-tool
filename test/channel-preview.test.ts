import { describe, it, expect } from 'vitest';
import { availableChannels, mentionedRoleNames } from '../app/admin/review/[id]/channel-preview.js';
import type { PreviewSet } from '../src/core/preview.js';

describe('availableChannels', () => {
  it('omits a broadcast channel with no matching destination', () => {
    const preview: PreviewSet = {
      discord: [],
      email: { subject: 's', text: 't', html: '<p>h</p>' },
      webhook: '{}',
    };

    expect(availableChannels(preview)).toEqual(['email', 'webhook']);
  });

  it('lists every channel that has a payload, in a stable order', () => {
    const preview: PreviewSet = {
      discord: [{ target: 'discord:mainnet-updates', content: 'c', roles: [] }],
      telegram: 'tg',
      signal: 'sig',
      email: { subject: 's', text: 't', html: '<p>h</p>' },
      webhook: '{}',
    };

    expect(availableChannels(preview)).toEqual(['discord', 'telegram', 'signal', 'email', 'webhook']);
  });

  it('returns an empty list when nothing will be sent', () => {
    expect(availableChannels({})).toEqual([]);
  });

  it('drops a channel whose payload the preview omitted', () => {
    // Task 4 makes a disabled channel absent from PreviewSet; availableChannels
    // already filters on absence, so this asserts the two conventions line up.
    const preview = { discord: [], telegram: undefined, signal: undefined,
                      email: { subject: 's', text: 't', html: 'h' }, webhook: undefined } as PreviewSet;
    expect(availableChannels(preview)).toEqual(['email']);
  });
});

describe('mentionedRoleNames', () => {
  it('names each selected role once, across destinations', () => {
    const preview: PreviewSet = {
      discord: [
        {
          target: 'discord:mainnet-updates',
          content: 'x',
          prefix: '<@&111> <@&222>',
          roles: [{ name: 'Mainnet Sequencer', id: '111' }, { name: 'Genesis Sequencer', id: '222' }],
        },
        {
          target: 'discord:testnet-updates',
          content: 'x',
          prefix: '<@&111>',
          roles: [{ name: 'Mainnet Sequencer', id: '111' }],
        },
      ],
    };

    expect(mentionedRoleNames(preview)).toEqual(['@Mainnet Sequencer', '@Genesis Sequencer']);
  });

  it('reports everyone and here literally', () => {
    const preview: PreviewSet = {
      discord: [{ target: 'd', content: 'x', prefix: '@everyone @here', roles: [] }],
    };

    expect(mentionedRoleNames(preview)).toEqual(['@everyone', '@here']);
  });

  it('falls back to the raw token for an id with no configured role', () => {
    const preview: PreviewSet = {
      discord: [{ target: 'd', content: 'x', prefix: '<@&999>', roles: [] }],
    };

    expect(mentionedRoleNames(preview)).toEqual(['<@&999>']);
  });

  it('is empty when no destination has a prefix', () => {
    const preview: PreviewSet = {
      discord: [{ target: 'd', content: 'x', roles: [] }],
    };

    expect(mentionedRoleNames(preview)).toEqual([]);
  });

  it('is empty when there is no discord destination at all', () => {
    expect(mentionedRoleNames({ telegram: 'tg' })).toEqual([]);
  });
});
