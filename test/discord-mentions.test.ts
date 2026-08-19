import { describe, it, expect } from 'vitest';
import { parseDiscordRoles, composeMentionLine, mentionedRoleIds, mentionsEveryone, MAX_PREFIX_LENGTH, validatePrefix } from '../src/core/discord-mentions.js';

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

  it('puts the emoji prefix before the mentions', () => {
    expect(composeMentionLine(both, [A.id])).toBe(`🇦🇿🇹🇪🇨 <@&${A.id}>`);
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
    expect(composeMentionLine(prefixOnly, ['everyone'])).toBe('🇦🇿 @everyone');
  });

  it('renders @here as a literal', () => {
    expect(composeMentionLine(withRoles, ['here'])).toBe('@here');
  });

  it('puts built-ins before configured roles', () => {
    expect(composeMentionLine(withRoles, [A.id, 'here'])).toBe(`@here <@&${A.id}>`);
  });

  it('strips a role mention pasted into the prefix', () => {
    const cfg = { roles: [A], prefix: '<@&999999999999999999> 🇦🇿' };
    expect(composeMentionLine(cfg as Record<string, unknown>, [A.id])).toBe(`🇦🇿 <@&${A.id}>`);
  });

  it('does not permit a role mention pasted into the prefix', () => {
    const cfg = { roles: [], prefix: '<@&999999999999999999> 🇦🇿' };
    expect(mentionedRoleIds(cfg as Record<string, unknown>, ['everyone'])).toEqual([]);
  });

  it('strips user mentions from the prefix too', () => {
    const cfg = { roles: [A], prefix: '<@123> <@!456> 🇦🇿' };
    expect(composeMentionLine(cfg as Record<string, unknown>, [A.id])).toBe(`🇦🇿 <@&${A.id}>`);
  });

  it('omits a prefix that is only a mention', () => {
    const cfg = { roles: [A], prefix: '<@&999999999999999999>' };
    expect(composeMentionLine(cfg as Record<string, unknown>, [A.id])).toBe(`<@&${A.id}>`);
  });

  it('strips a spliced mention that would reconstruct after one pass', () => {
    const cfg = { roles: [A], prefix: '<@&<@&123>456> 🇦🇿' };
    expect(composeMentionLine(cfg as Record<string, unknown>, [A.id])).toBe(`🇦🇿 <@&${A.id}>`);
  });

  it('does not permit a spliced mention from the prefix', () => {
    const cfg = { roles: [A], prefix: '<@&<@&123>456>' };
    expect(mentionedRoleIds(cfg as Record<string, unknown>, [A.id])).toEqual([A.id]);
  });

  it('strips other splice shapes', () => {
    for (const p of ['<@&1<@&2>11>', '<@<@&1>&456>', '<@&12<@123>34>']) {
      const cfg = { roles: [A], prefix: p };
      expect(composeMentionLine(cfg as Record<string, unknown>, [A.id])).toBe(`<@&${A.id}>`);
    }
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

  it('reports nothing when the selection is undefined', () => {
    expect(mentionedRoleIds(withRoles, undefined)).toEqual([]);
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

describe('validatePrefix', () => {
  it('accepts an empty prefix', () => {
    expect(validatePrefix('')).toBeUndefined();
  });

  it('accepts a realistic emoji preamble', () => {
    const preamble = ['a', 'z', 't', 'e', 'c']
      .map((c, i) => `<:aztec_${c}:12345678901234567${i}>`)
      .join(' ');
    expect(preamble.length).toBeLessThan(MAX_PREFIX_LENGTH);
    expect(validatePrefix(preamble)).toBeUndefined();
  });

  it('accepts a prefix exactly at the cap', () => {
    expect(validatePrefix('x'.repeat(MAX_PREFIX_LENGTH))).toBeUndefined();
  });

  it('refuses a prefix one character over the cap', () => {
    const err = validatePrefix('x'.repeat(MAX_PREFIX_LENGTH + 1));
    expect(err).toBeDefined();
    // The message must state both numbers, so an operator knows how much to cut.
    expect(err).toContain(String(MAX_PREFIX_LENGTH));
    expect(err).toContain(String(MAX_PREFIX_LENGTH + 1));
  });

  it('measures the raw input, not the stripped result', () => {
    // Nested splice input collapses to '' under stripRoleMentions. If the cap
    // measured the stripped value this would pass, and the expensive input
    // would be stored — the exact accident this cap exists to refuse.
    let nested = '<@&1>';
    for (let i = 0; i < 200; i++) nested = `<@&${nested}2>`;
    expect(nested.length).toBeGreaterThan(MAX_PREFIX_LENGTH);
    expect(validatePrefix(nested)).toBeDefined();
  });
});

describe('composeMentionLine with an over-long stored prefix', () => {
  it('still composes, because the cap guards entry and not stored rows', () => {
    // A destination configured before the cap existed must keep working.
    const cfg = {
      prefix: 'P'.repeat(MAX_PREFIX_LENGTH + 50),
      roles: [{ name: 'Mainnet', id: '111' }],
    };
    const line = composeMentionLine(cfg, ['111']);
    expect(line).toBeDefined();
    expect(line).toContain('<@&111>');
  });
});
