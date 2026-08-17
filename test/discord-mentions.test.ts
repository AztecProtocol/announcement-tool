import { describe, it, expect } from 'vitest';
import { parseDiscordRoles, composeMentionLine, mentionedRoleIds, mentionsEveryone } from '../src/core/discord-mentions.js';

const A = { name: 'mainnet-sequencer', id: '1538890653835075584' };
const B = { name: 'genesis-sequencer', id: '1538890653835075585' };
const withRoles = { roles: [A, B] } as Record<string, unknown>;
const both = { roles: [A, B], prefix: '🇦🇿🇹🇪🇨' } as Record<string, unknown>;
const prefixOnly = { prefix: '🇦🇿' } as Record<string, unknown>;

describe('parseDiscordRoles', () => {
  it('reads well-formed pairs', () => {
    expect(parseDiscordRoles(withRoles)).toEqual([A, B]);
  });

  it('returns an empty list when roles are absent', () => {
    expect(parseDiscordRoles(prefixOnly)).toEqual([]);
  });

  it('skips malformed entries rather than throwing', () => {
    const messy = { roles: [A, { name: 'no-id' }, { id: '123' }, 'nonsense', null] };
    expect(parseDiscordRoles(messy as Record<string, unknown>)).toEqual([A]);
  });

  it('refuses a configured role that shadows a built-in id', () => {
    const shadow = { roles: [{ name: 'fake', id: 'everyone' }, A] };
    expect(parseDiscordRoles(shadow as Record<string, unknown>)).toEqual([A]);
  });
});

describe('composeMentionLine', () => {
  it('mentions only the selected role', () => {
    expect(composeMentionLine(withRoles, [A.id])).toBe(`<@&${A.id}>`);
  });

  it('mentions several selected roles in config order', () => {
    expect(composeMentionLine(withRoles, [B.id, A.id])).toBe(`<@&${A.id}> <@&${B.id}>`);
  });

  it('appends the emoji prefix after the mentions', () => {
    expect(composeMentionLine(both, [A.id])).toBe(`<@&${A.id}> 🇦🇿🇹🇪🇨`);
  });

  it('returns undefined when nothing is selected', () => {
    expect(composeMentionLine(withRoles, [])).toBeUndefined();
    expect(composeMentionLine(withRoles, undefined)).toBeUndefined();
  });

  it('does not mention from a bare prefix without a selection', () => {
    // Deliberate change: mentions come only from an explicit selection now.
    expect(composeMentionLine(prefixOnly, undefined)).toBeUndefined();
  });

  it('ignores an id the destination does not offer', () => {
    expect(composeMentionLine(withRoles, ['not-a-configured-id'])).toBeUndefined();
  });

  it('renders @everyone as a literal, not a role id', () => {
    expect(composeMentionLine(prefixOnly, ['everyone'])).toBe('@everyone 🇦🇿');
  });

  it('renders @here as a literal', () => {
    expect(composeMentionLine(withRoles, ['here'])).toBe('@here');
  });

  it('puts built-ins before configured roles', () => {
    expect(composeMentionLine(withRoles, [A.id, 'here'])).toBe(`@here <@&${A.id}>`);
  });
});

describe('mentionedRoleIds', () => {
  it('reports the selected snowflake ids', () => {
    expect(mentionedRoleIds(withRoles, [A.id])).toEqual([A.id]);
  });

  it('excludes built-ins, which are not role ids', () => {
    expect(mentionedRoleIds(withRoles, ['everyone', A.id])).toEqual([A.id]);
  });

  it('reports nothing when no mention will be sent', () => {
    expect(mentionedRoleIds(withRoles, [])).toEqual([]);
  });
});

describe('mentionsEveryone', () => {
  it('is true when everyone or here is selected', () => {
    expect(mentionsEveryone(['everyone'])).toBe(true);
    expect(mentionsEveryone(['here'])).toBe(true);
  });

  it('is false otherwise', () => {
    expect(mentionsEveryone([A.id])).toBe(false);
    expect(mentionsEveryone(undefined)).toBe(false);
  });
});
