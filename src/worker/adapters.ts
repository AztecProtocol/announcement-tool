import type { Sql } from 'postgres';
import type { ChannelAdapter } from '../adapters/types.js';
import type { EmailSender } from '../adapters/esp.js';
import { makeWebhookAdapter } from '../adapters/webhook.js';
import { makeDiscordAdapter } from '../adapters/discord.js';
import { makeTelegramAdapter } from '../adapters/telegram.js';
import { makeEmailAdapter } from '../adapters/email.js';
import { makeSignalAdapter } from '../adapters/signal.js';
import { enabledChannels } from '../core/enabled-channels.js';

/** Every channel this tool knows how to fan out to. Which of these actually
 *  run on a given deployment is configuration (ENABLED_CHANNELS), not a
 *  property of this type — see src/core/enabled-channels.ts. */
export type ChannelName = 'webhook' | 'discord' | 'telegram' | 'email' | 'signal';

/**
 * Builds the adapter map for the requested channels. Both hosts (the always-on
 * VM worker in main.ts, and the Netlify background function) call this instead
 * of constructing the map themselves, so there is exactly one place that knows
 * how to build each adapter — copying the map would let the two hosts drift
 * apart the same way a second copy of runTick would.
 *
 * The default reads ENABLED_CHANNELS via enabledChannels(), so an unset
 * variable still builds all five (today's VM behaviour is preserved) and a
 * set variable builds only what it names. Pass an explicit list to override
 * the variable entirely, e.g. from a test or a one-off script.
 */
export function buildAdapters(
  sql: Sql,
  sender: EmailSender,
  channels: ChannelName[] = enabledChannels(),
): Record<string, ChannelAdapter> {
  const adapters: Record<string, ChannelAdapter> = {};
  for (const channel of channels) {
    switch (channel) {
      case 'webhook':
        adapters.webhook = makeWebhookAdapter(sql);
        break;
      case 'discord':
        adapters.discord = makeDiscordAdapter(sql);
        break;
      case 'telegram':
        adapters.telegram = makeTelegramAdapter(sql);
        break;
      case 'email':
        adapters.email = makeEmailAdapter(sql, sender);
        break;
      case 'signal':
        adapters.signal = makeSignalAdapter(sql);
        break;
    }
  }
  return adapters;
}
