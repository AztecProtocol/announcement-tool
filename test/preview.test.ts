import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { previewAnnouncement } from '../src/core/preview.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
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
    const prefix = '@here <:AztecDiscordEmoji_A:1> <@&Mainnet>';
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix,
      })})`;
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:testnet-updates', 'discord', ${sql.json({
        networks: ['testnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook2', prefix: 'other',
      })})`;

    const preview = await previewAnnouncement(sql, { ...input, mentionRoles: true });

    expect(preview.discord).toHaveLength(1);
    expect(preview.discord![0].target).toBe('discord:mainnet-updates');
    expect(preview.discord![0].content.startsWith(prefix)).toBe(true);
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
    const prefix = '@here <:AztecDiscordEmoji_A:1> <@&Mainnet>';
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoles: true });
    const entry = res.discord?.[0];
    expect(entry).toBeDefined();
    expect(entry!.prefix).toBe(prefix);
    expect(entry!.content).toBe(`${prefix}\n${entry!.content.slice(prefix.length + 1)}`);
    expect(entry!.content.startsWith(prefix)).toBe(true);
  });

  it('leaves the discord content byte-identical to the adapter payload', async () => {
    const prefix = '@here <:AztecDiscordEmoji_A:1> <@&Mainnet>';
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoles: true });
    const entry = res.discord?.[0];
    expect(entry).toBeDefined();
    // The adapter composes exactly this: prefix + '\n' + renderMarkdown(a, kind),
    // or renderMarkdown alone when no prefix is configured.
    expect(entry!.content.startsWith(`${prefix}\n`)).toBe(true);
  });

  it('honours a supplied slug in the canonical URL instead of generating one', async () => {
    const withSlug: AnnouncementInput = { ...input, slug: 'author-chosen-slug' };
    const preview = await previewAnnouncement(sql, withSlug);
    expect(preview.webhook).toBeDefined();
    const parsed = JSON.parse(preview.webhook!);
    expect(parsed.announcement.slug).toBe('author-chosen-slug');
    expect(preview.email!.html).toContain('author-chosen-slug');
  });

  it('omits the discord prefix in the preview when mentionRoles is false', async () => {
    const prefix = '@here <:AztecDiscordEmoji_A:1> <@&Mainnet>';
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoles: false });
    const entry = res.discord?.[0];
    expect(entry?.prefix).toBeUndefined();
    expect(entry?.content).not.toContain('<@&');
  });

  it('includes the discord prefix in the preview when mentionRoles is true', async () => {
    const prefix = '@here <:AztecDiscordEmoji_A:1> <@&Mainnet>';
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({
        networks: ['mainnet'], types: ['upgrade'], webhook_url: 'https://example.com/hook', prefix,
      })})`;

    const res = await previewAnnouncement(sql, { ...input, mentionRoles: true });
    const entry = res.discord?.[0];
    expect(entry?.prefix).toBe(prefix);
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
});
