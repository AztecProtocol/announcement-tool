import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { previewAnnouncement, previewStored } from '../src/core/preview.js';
import { resetEnabledChannelsCache } from '../src/core/enabled-channels.js';
import type { Announcement, AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterEach(() => {
  delete process.env.ENABLED_CHANNELS;
  resetEnabledChannelsCache();
});
afterAll(async () => { await sql.end(); });

const input: AnnouncementInput = {
  type: 'upgrade',
  networks: ['mainnet'],
  audiences: ['operators'],
  severity: 'critical',
  title: 'Upgrade now',
  bodyMd: 'Body text.',
  actionsRequired: [],
  links: [],
};

describe('previewAnnouncement', () => {
  it('discord: only the matching channel gets a preview, prefix verbatim, markdown rendered', async () => {
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix, roles,
      })})`;
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:testnet-updates', 'discord', ${sql.json({
        networks: ['testnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook2', prefix: 'other',
      })})`;

    const preview = await previewAnnouncement(sql, { ...input, mentionRoleIds: ['111'] });

    expect(preview.discord).toHaveLength(1);
    expect(preview.discord![0].target).toBe('discord:mainnet-updates');
    expect(preview.discord![0].content.startsWith(`${prefix} <@&111>`)).toBe(true);
    expect(preview.discord![0].content).toContain('**Upgrade now**');
    expect(preview.discord![0].content).toContain('Body text.');
  });

  it('discord: a channel whose networks/types do not match produces no preview entry', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:testnet-updates', 'discord', ${sql.json({
        networks: ['testnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook',
      })})`;

    const preview = await previewAnnouncement(sql, input);
    expect(preview.discord).toHaveLength(0);
  });

  it('discord: works without a configured prefix', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook',
      })})`;
    const preview = await previewAnnouncement(sql, input);
    expect(preview.discord).toHaveLength(1);
    expect(preview.discord![0].content.startsWith('**Upgrade now**')).toBe(false);
    expect(preview.discord![0].content).toContain('[MAINNET] [CRITICAL] [UPGRADE]');
  });

  it('telegram preview uses HTML mode when a matching telegram channel_settings row exists', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:mainnet', 'telegram', ${sql.json({ networks: ['mainnet'], types: ['upgrade'] })})`;
    const preview = await previewAnnouncement(sql, input);
    expect(preview.telegram).toContain('<b>Upgrade now</b>');
  });

  it('telegram preview is undefined when no telegram channel_settings row matches', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.telegram).toBeUndefined();
  });

  it('telegram preview is undefined when a telegram row exists but its network/type does not match', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:testnet', 'telegram', ${sql.json({ networks: ['testnet'], types: ['upgrade'] })})`;
    const preview = await previewAnnouncement(sql, input);
    expect(preview.telegram).toBeUndefined();
  });

  it('email preview subject matches renderEmail', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.email!.subject).toContain('Upgrade now');
    expect(preview.email!.subject).toContain('[MAINNET]');
    expect(preview.email!.text).toContain('Body text.');
  });

  it('includes the email html part alongside the text part', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.email?.html).toContain('<h1');
    expect(preview.email?.html).toContain(input.title);
  });

  it('keeps the unsubscribe placeholder unresolved in the preview html', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.email?.html).toContain('{{UNSUBSCRIBE}}');
  });

  it('webhook preview is valid JSON containing event_id and actions_required', async () => {
    const preview = await previewAnnouncement(sql, input);
    const parsed = JSON.parse(preview.webhook!);
    expect(parsed.event_id).toContain('ann_preview');
    expect(parsed.announcement.actions_required).toEqual([]);
  });

  it('signal preview uses plain text rendering when a matching signal channel_settings row exists', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('signal:mainnet', 'signal', ${sql.json({ networks: ['mainnet'], types: ['upgrade'] })})`;
    const preview = await previewAnnouncement(sql, input);
    expect(preview.signal).toContain('Upgrade now');
    expect(preview.signal).not.toContain('**');
  });

  it('signal preview is undefined when no signal channel_settings row matches', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.signal).toBeUndefined();
  });

  it('rejects invalid input (e.g. a javascript: link) with a validation error instead of a rendered preview', async () => {
    const badInput: AnnouncementInput = {
      ...input,
      links: [{ label: 'evil', url: 'javascript:alert(1)' }],
    };
    const preview = await previewAnnouncement(sql, badInput);
    expect(preview.error).toBeDefined();
    expect(preview.discord).toBeUndefined();
    expect(preview.email).toBeUndefined();
    expect(preview.webhook).toBeUndefined();
  });

  it('surfaces the non-blocking GitHub-release warning alongside a successful preview', async () => {
    const preview = await previewAnnouncement(sql, input); // type: upgrade, no github release link
    expect(preview.error).toBeUndefined();
    expect(preview.warnings).toBeDefined();
    expect(preview.warnings!.some(w => w.includes('GitHub release'))).toBe(true);
    expect(preview.email).toBeDefined();
  });

  it('does not surface warnings when validation passes cleanly', async () => {
    const cleanInput: AnnouncementInput = { ...input, type: 'info' };
    const preview = await previewAnnouncement(sql, cleanInput);
    expect(preview.error).toBeUndefined();
    expect(preview.warnings).toBeUndefined();
  });

  it('carries the discord prefix as its own field', async () => {
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix, roles,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoleIds: ['111'] });
    const entry = res.discord?.[0];
    expect(entry).toBeDefined();
    const expectedPrefix = `${prefix} <@&111>`;
    expect(entry!.prefix).toBe(expectedPrefix);
    expect(entry!.content).toBe(`${expectedPrefix}\n${entry!.content.slice(expectedPrefix.length + 1)}`);
    expect(entry!.content.startsWith(expectedPrefix)).toBe(true);
  });

  it('leaves the discord content byte-identical to the adapter payload', async () => {
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix, roles,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoleIds: ['111'] });
    const entry = res.discord?.[0];
    expect(entry).toBeDefined();
    // The adapter composes exactly this: composeMentionLine(cfg, a.mentionRoleIds)
    // + '\n' + renderMarkdown(a, kind), or renderMarkdown alone when the
    // composed line is undefined.
    // Blank line between prefix and body — must match src/adapters/discord.ts byte for byte.
    expect(entry!.content.startsWith(`${prefix} <@&111>\n\n`)).toBe(true);
  });

  it('honours a supplied slug in the canonical URL instead of generating one', async () => {
    const withSlug: AnnouncementInput = { ...input, slug: 'author-chosen-slug' };
    const preview = await previewAnnouncement(sql, withSlug);
    expect(preview.webhook).toBeDefined();
    const parsed = JSON.parse(preview.webhook!);
    expect(parsed.announcement.slug).toBe('author-chosen-slug');
    expect(preview.email!.html).toContain('author-chosen-slug');
  });

  it('omits the discord prefix in the preview when no role is selected', async () => {
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix, roles,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoleIds: [] });
    const entry = res.discord?.[0];
    expect(entry?.prefix).toBeUndefined();
    expect(entry?.content).not.toContain('<@&');
  });

  it('includes the discord prefix in the preview when a role is selected', async () => {
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix, roles,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoleIds: ['111'] });
    const entry = res.discord?.[0];
    expect(entry?.prefix).toBe(`${prefix} <@&111>`);
  });

  it('exposes the destination roles so the form can offer them', async () => {
    const roles = [{ name: 'mainnet-sequencer', id: '333' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', roles,
      })})`;

    const res = await previewAnnouncement(sql, input);
    expect(res.discord?.[0]?.roles.map(r => r.name)).toContain('mainnet-sequencer');
  });

  it('shows only the selected role in the preview content', async () => {
    const roles = [{ name: 'role-a', id: '111' }, { name: 'role-b', id: '222' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', roles,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoleIds: ['111'] });
    expect(res.discord?.[0]?.content).toContain('<@&111>');
    expect(res.discord?.[0]?.content).not.toContain('<@&222>');
  });

  it('does not treat the "update"-kind tag line as a discord prefix', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook',
      })})`;

    const res = await previewAnnouncement(sql, input, 'update');
    const entry = res.discord?.[0];
    expect(entry).toBeDefined();
    expect(entry!.prefix).toBeUndefined();
    expect(entry!.content.startsWith('UPDATED: [MAINNET]')).toBe(true);
  });

  it('omits signal from the preview when signal is disabled', async () => {
    process.env.ENABLED_CHANNELS = 'discord,email,webhook';
    resetEnabledChannelsCache();
    const preview = await previewAnnouncement(sql, input);
    expect(preview.signal).toBeUndefined();
  });

  it('omits email and webhook when they are disabled, though they have no settings row', async () => {
    // email and webhook are built unconditionally today, so a targets-based
    // filter alone would leave them in the preview. This is the case that
    // catches a half-applied gate.
    process.env.ENABLED_CHANNELS = 'discord';
    resetEnabledChannelsCache();
    const preview = await previewAnnouncement(sql, input);
    expect(preview.email).toBeUndefined();
    expect(preview.webhook).toBeUndefined();
  });

  it('leaves discord empty rather than undefined when disabled, matching its array convention', async () => {
    process.env.ENABLED_CHANNELS = 'email';
    resetEnabledChannelsCache();
    const preview = await previewAnnouncement(sql, input);
    expect(preview.discord ?? []).toEqual([]);
  });
});

/** A stored announcement whose title would derive a slug different from the stored one. */
const stored = (over: Partial<Announcement> = {}): Announcement => ({
  ...input,
  id: 'ann_01STORED',
  revision: 3,
  slug: '2026-08-a-real-stored-slug',
  status: 'draft',
  createdBy: 'author@example.com',
  title: 'A title that would derive a completely different slug',
  ...over,
});

describe('previewStored', () => {
  it('keeps the stored id, revision and slug in the webhook payload', async () => {
    const payload = JSON.parse((await previewStored(sql, stored())).webhook!);

    expect(payload.event_id).toBe('ann_01STORED.3.publish');
    expect(payload.announcement.id).toBe('ann_01STORED');
    expect(payload.announcement.revision).toBe(3);
    expect(payload.announcement.slug).toBe('2026-08-a-real-stored-slug');
  });

  it('puts the stored slug in the canonical link of every rendered channel', async () => {
    // Telegram and Signal only render when a matching channel_settings row exists.
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:mainnet', 'telegram', ${sql.json({ networks: ['mainnet'], types: ['upgrade'] })})`;
    await sql`insert into channel_settings (key, channel, config) values
      ('signal:mainnet', 'signal', ${sql.json({ networks: ['mainnet'], types: ['upgrade'] })})`;

    const preview = await previewStored(sql, stored({ revision: 1 }));

    expect(preview.telegram).toContain('2026-08-a-real-stored-slug');
    expect(preview.signal).toContain('2026-08-a-real-stored-slug');
    expect(preview.email!.text).toContain('2026-08-a-real-stored-slug');
  });

  it('reports published_at as null for an announcement that has not published yet', async () => {
    const payload = JSON.parse((await previewStored(sql, stored())).webhook!);

    expect(payload.announcement.published_at).toBeNull();
  });

  it('still surfaces validation warnings for a stored draft', async () => {
    // type 'upgrade' with no GitHub release link is the existing warning case.
    const preview = await previewStored(sql, stored({ type: 'upgrade', links: [] }));

    expect(preview.warnings?.length).toBeGreaterThan(0);
  });
});
