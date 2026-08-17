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

  return [...builtins, ...roles, ...(prefix ? [prefix] : [])].join(' ').trim() || undefined;
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
