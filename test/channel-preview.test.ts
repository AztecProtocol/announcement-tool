import { describe, it, expect } from 'vitest';
import { availableChannels } from '../app/admin/review/[id]/channel-preview.js';
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
});
