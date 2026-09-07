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

  it('attaches PUBLIC_DISCORD_NOTE to the Discord entry only, trimmed', () => {
    expect(broadcastLinks({
      PUBLIC_DISCORD_URL: 'https://discord.gg/aztec',
      PUBLIC_TELEGRAM_URL: 'https://t.me/+abc',
      PUBLIC_DISCORD_NOTE: '  Channels: #mainnet-updates, #testnet-updates  ',
    })).toEqual([
      { label: 'Discord', url: 'https://discord.gg/aztec', note: 'Channels: #mainnet-updates, #testnet-updates' },
      { label: 'Telegram', url: 'https://t.me/+abc' },
    ]);
  });

  it('ignores the note when the Discord link is absent or the note is blank or too long', () => {
    expect(broadcastLinks({ PUBLIC_DISCORD_NOTE: 'Channels: #x' })).toEqual([]);
    expect(broadcastLinks({ PUBLIC_DISCORD_URL: 'https://discord.gg/aztec', PUBLIC_DISCORD_NOTE: '   ' }))
      .toEqual([{ label: 'Discord', url: 'https://discord.gg/aztec' }]);
    expect(broadcastLinks({ PUBLIC_DISCORD_URL: 'https://discord.gg/aztec', PUBLIC_DISCORD_NOTE: 'x'.repeat(201) }))
      .toEqual([{ label: 'Discord', url: 'https://discord.gg/aztec' }]);
  });
});
