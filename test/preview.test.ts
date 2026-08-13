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

    const preview = await previewAnnouncement(sql, input);

    expect(preview.discord).toHaveLength(1);
    expect(preview.discord[0].target).toBe('discord:mainnet-updates');
    expect(preview.discord[0].content.startsWith(prefix)).toBe(true);
    expect(preview.discord[0].content).toContain('**Upgrade now**');
    expect(preview.discord[0].content).toContain('Body text.');
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
    expect(preview.discord[0].content.startsWith('**Upgrade now**')).toBe(false);
    expect(preview.discord[0].content).toContain('[MAINNET] [CRITICAL] [UPGRADE]');
  });

  it('telegram preview uses HTML mode', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.telegram).toContain('<b>Upgrade now</b>');
  });

  it('email preview subject matches renderEmail', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.email.subject).toContain('Upgrade now');
    expect(preview.email.subject).toContain('[MAINNET]');
    expect(preview.email.text).toContain('Body text.');
  });

  it('webhook preview is valid JSON containing event_id and actions_required', async () => {
    const preview = await previewAnnouncement(sql, input);
    const parsed = JSON.parse(preview.webhook);
    expect(parsed.event_id).toContain('ann_preview');
    expect(parsed.announcement.actions_required).toEqual([]);
  });

  it('signal preview uses plain text rendering', async () => {
    const preview = await previewAnnouncement(sql, input);
    expect(preview.signal).toContain('Upgrade now');
    expect(preview.signal).not.toContain('**');
  });
});
