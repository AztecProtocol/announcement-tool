import type { ChannelName } from '../worker/adapters.js';

/**
 * Which channels this deployment fans out to.
 *
 * WHY THIS EXISTS. Signal ships in the codebase but has no phone number yet
 * (2026-08-27), and the Netlify shape has no signal-cli sidecar to run it
 * against at all. Before this module, each host hard-coded its own channel
 * list — src/worker/main.ts listed five, netlify/functions/tick-background.ts
 * listed four — so "turn a channel off" meant editing code on two branches and
 * hoping the admin UI agreed.
 *
 * THE GATE IS AT ENQUEUE. countFanoutTargets does not create a delivery_ledger
 * row for a disabled channel, so nothing downstream has to cope with one.
 *
 * Two backstops sit behind that, and it is worth knowing they are backstops
 * rather than the mechanism — an earlier version of this comment described the
 * unguarded failure as if it were live, and a reviewer duly "found" it:
 *   - runFanoutOnce selects `... and channel in (Object.keys(adapters))`, so a
 *     row whose channel has no adapter is never even fetched.
 *   - if one is fetched anyway (a caller injecting an adapter map that does not
 *     come from buildAdapters), fanout.ts skips it and leaves it pending.
 * Without those, `adapters[row.channel].deliver(...)` would throw a TypeError,
 * be caught as an ordinary delivery failure, burn MAX_ATTEMPTS retries, reach
 * 'exhausted', and alert about a channel switched off on purpose.
 *
 * IT MUST NOT REWRITE HISTORY. This governs composing, previewing and
 * enqueueing only. delivery_ledger reads stay unfiltered: an announcement that
 * published to Telegram must still show that delivery after Telegram is
 * disabled, or the audit record silently loses rows.
 */
const ALL: ChannelName[] = ['webhook', 'discord', 'telegram', 'email', 'signal'];

/**
 * Parses the ENABLED_CHANNELS value.
 *
 * Absent or blank means ALL, which preserves the behaviour every existing
 * deployment has today — this variable is opt-in, so an operator who has not
 * heard of it keeps their five channels.
 *
 * An unrecognised name THROWS. Skipping it would mean a typo
 * (ENABLED_CHANNELS=discord,emial) silently disables a channel the operator
 * believes is on, and the failure would surface as "the announcement reached
 * nobody by email" long after the deploy. Refusing to start is noticed at once.
 */
export function parseEnabledChannels(raw: string | undefined): ChannelName[] {
  if (raw === undefined || raw.trim() === '') return [...ALL];

  const out: ChannelName[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (name === '') continue;
    if (!(ALL as string[]).includes(name)) {
      throw new Error(
        `ENABLED_CHANNELS: unknown channel "${part.trim()}". Valid channels: ${ALL.join(', ')}.`,
      );
    }
    const channel = name as ChannelName;
    if (!out.includes(channel)) out.push(channel);
  }
  return out;
}

let cached: ChannelName[] | undefined;

/**
 * Memoised so every caller in a process sees one answer. Without this a
 * long-lived worker could enqueue against one set and deliver against another
 * if the variable changed underneath it.
 */
export function enabledChannels(): ChannelName[] {
  cached ??= parseEnabledChannels(process.env.ENABLED_CHANNELS);
  return cached;
}

export function isChannelEnabled(c: ChannelName): boolean {
  return enabledChannels().includes(c);
}

/** Test-only. Clears the memo so a test can set the variable and re-read it. */
export function resetEnabledChannelsCache(): void {
  cached = undefined;
}
