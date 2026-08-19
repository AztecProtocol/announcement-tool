import type { DiscordRole } from './types.js';

/**
 * Composes the mention line that goes above a Discord message.
 *
 * This is the ONE place that decides what gets mentioned. Both
 * src/adapters/discord.ts and src/core/preview.ts call it, so the Raw preview
 * cannot drift from what is actually posted — that preview is the accepted
 * mitigation for sending allowed_mentions with mentions enabled.
 *
 * Mentions come only from an explicit selection. A destination's `prefix` is
 * the emoji preamble and never mentions on its own.
 */

const ROLE_MENTION = (id: string) => `<@&${id}>`;

/**
 * @everyone and @here are offered like roles but are not roles: Discord
 * resolves them from literal text and they carry no snowflake id. They are kept
 * out of the configured list so a destination cannot shadow them.
 */
export const BUILTIN_ROLES: DiscordRole[] = [
  { name: 'everyone', id: 'everyone' },
  { name: 'here', id: 'here' },
];

const BUILTIN_IDS = new Set(BUILTIN_ROLES.map(r => r.id));

/**
 * The prefix is the emoji preamble, not a mention field. An operator can paste
 * a role or user mention into it — Discord's UI autocompletes them in any text
 * box — and it would otherwise be posted AND permitted despite never being
 * selected. Mentions come only from the selection, so strip any that appear
 * here. Covers <@&123> (role), <@123> and <@!123> (user) — all three resolve
 * as pings in Discord.
 *
 * A literal @everyone / @here typed into the prefix is stripped too: they are
 * selectable entries now, so a literal one in the preamble is the same
 * bypass in spirit, even though it cannot ping today without the built-in
 * also being selected (parse: ['everyone'] is only sent then).
 *
 * The strip runs to a fixed point rather than a single pass. A single pass
 * is bypassable by splicing: `<@&<@&123>456>` has no match for the mention
 * regex as a whole, but stripping the inner `<@&123>` first collapses the
 * remainder to `<@&456>` — a live mention that was never typed as such and
 * never selected. Looping until a pass changes nothing closes this, because
 * each pass either removes something (making the string strictly shorter)
 * or leaves it unchanged (which ends the loop). Do not "simplify" this back
 * to one pass — that reopens the splice bypass.
 */

/**
 * Longest accepted Discord destination prefix, in UTF-16 code units.
 *
 * The prefix is the emoji preamble. In the wire form Discord requires for a
 * custom emoji (`<:name:id>`) each one costs roughly 25-30 ASCII characters,
 * so a five-emoji preamble is about 150. 512 leaves room to grow the set or
 * add words.
 *
 * The cap exists because stripRoleMentions runs to a fixed point and is
 * therefore O(n^2) on nested splice input: measured on this loop, 10 KB costs
 * 12.5 ms, 20 KB costs 49.8 ms and 80 KB costs 764 ms. That is not an attack
 * path — only scripts/setup-channel.ts writes a prefix, and running it needs
 * shell access to the server, which already grants the database and the
 * webhook URLs. It is an accident guard: without a cap, a mis-paste is stored
 * silently and then charged to every preview render and every Discord
 * delivery, invisibly, forever. At 512 characters the loop costs far under a
 * millisecond.
 */
export const MAX_PREFIX_LENGTH = 512;

/**
 * Checks a prefix a human just entered. Returns a message to show them, or
 * undefined when the prefix is acceptable.
 *
 * Deliberately NOT called from composeMentionLine. That function runs against
 * rows already in the database, some written before this cap existed, and
 * refusing there would break an existing destination at send time — a worse
 * failure than the accident this prevents. Enforce at entry only.
 *
 * Measures the RAW string, before stripRoleMentions. That is the length the
 * loop's cost scales with; measuring the stripped result would admit a 40 KB
 * nested input that collapses to an empty string.
 */
export function validatePrefix(prefix: string): string | undefined {
  if (prefix.length <= MAX_PREFIX_LENGTH) return undefined;
  return `prefix is ${prefix.length} characters; the maximum is ${MAX_PREFIX_LENGTH}`;
}

const stripRoleMentions = (s: string) => {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<@[&!]?\d+>/g, '').replace(/@(?:everyone|here)\b/g, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim();
};

export function parseDiscordRoles(config: Record<string, unknown>): DiscordRole[] {
  const raw = config.roles;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(r => {
    if (typeof r !== 'object' || r === null) return [];
    const { name, id } = r as Partial<DiscordRole>;
    if (typeof name !== 'string' || typeof id !== 'string') return [];
    if (!name.trim() || !id.trim()) return [];
    if (BUILTIN_IDS.has(id.trim())) return []; // never shadow @everyone / @here
    return [{ name: name.trim(), id: id.trim() }];
  });
}

export function composeMentionLine(
  cfg: Record<string, unknown>, selectedIds: string[] | undefined,
): string | undefined {
  if (!selectedIds || selectedIds.length === 0) return undefined;

  const prefix = stripRoleMentions((cfg.prefix as string | undefined) ?? '');

  // Built-ins first, then configured roles in config order — not selection
  // order — so the line reads the same however the author clicked.
  const builtins = BUILTIN_ROLES
    .filter(r => selectedIds.includes(r.id))
    .map(r => `@${r.name}`);
  const roles = parseDiscordRoles(cfg)
    .filter(r => selectedIds.includes(r.id))
    .map(r => ROLE_MENTION(r.id));

  if (builtins.length === 0 && roles.length === 0) return undefined;

  // The prefix (the emoji preamble) leads, then the mentions. Discord renders
  // a mention as a coloured pill, so putting the emoji first keeps the branding
  // at the start of the line where a reader's eye lands.
  return [...(prefix ? [prefix] : []), ...builtins, ...roles].join(' ').trim() || undefined;
}

/** The snowflake role ids the composed line mentions. Excludes built-ins. */
export function mentionedRoleIds(
  cfg: Record<string, unknown>, selectedIds: string[] | undefined,
): string[] {
  const line = composeMentionLine(cfg, selectedIds);
  if (!line) return [];
  return [...line.matchAll(/<@&(\d+)>/g)].map(m => m[1]);
}

/** Whether the selection needs Discord's un-narrowable everyone permission. */
export function mentionsEveryone(selectedIds: string[] | undefined): boolean {
  return !!selectedIds?.some(id => BUILTIN_IDS.has(id));
}
