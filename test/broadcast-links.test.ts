import { describe, expect, it } from 'vitest';
import { broadcastLinks } from '../src/web/broadcast-links.js';

describe('broadcastLinks', () => {
  it('returns nothing when no link variable is set', () => {
    expect(broadcastLinks({})).toEqual([]);
  });

  it('returns only the channels whose variable is set, in a fixed order', () => {
    expect(broadcastLinks({
      PUBLIC_SIGNAL_URL: 'https://signal.group/#abc',
      PUBLIC_DISCORD_URL: 'https://discord.gg/aztec',
    })).toEqual([
      { label: 'Discord', url: 'https://discord.gg/aztec' },
      { label: 'Signal', url: 'https://signal.group/#abc' },
    ]);
  });

  it('ignores empty and whitespace-only values', () => {
    expect(broadcastLinks({ PUBLIC_TELEGRAM_URL: '   ', PUBLIC_DISCORD_URL: '' })).toEqual([]);
  });

  it('accepts only http and https URLs', () => {
    expect(broadcastLinks({ PUBLIC_TELEGRAM_URL: 'javascript:alert(1)' })).toEqual([]);
    expect(broadcastLinks({ PUBLIC_TELEGRAM_URL: 'https://t.me/+abc' })).toEqual([
      { label: 'Telegram', url: 'https://t.me/+abc' },
    ]);
  });
});
