import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { makeDiscordAdapter } from '../src/adapters/discord.js';
import type { Announcement } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const ann: Announcement = {
  id: 'ann_D', revision: 1, slug: 'slug-d', type: 'upgrade', networks: ['mainnet'],
  audiences: ['operators'], severity: 'critical', title: 'Upgrade now', bodyMd: 'Body.',
  actionsRequired: [], links: [], status: 'published', createdBy: 'a@x',
};

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}/webhook` });
    });
  });
}

describe('discord adapter', () => {
  it('posts rendered markdown with the configured prefix verbatim', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    // Pasted mentions in the prefix text are stripped (see discord-mentions.ts);
    // the mention line is built only from the selection, so give the fixture
    // an explicit selection and expect that composed line, not the raw prefix.
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, prefix, roles, username: 'Aztec Announcements' })})`;

    const adapter = makeDiscordAdapter(sql);
    await adapter.deliver({ ...ann, mentionRoleIds: ['111'] }, 'discord:mainnet-updates', 'publish');
    server.close();

    const payload = JSON.parse(body);
    expect(payload.content.startsWith(`${prefix} <@&111>`)).toBe(true);
    // A blank line separates the mention prefix from the body, so the tag line is
    // not crowded against the role pings. startsWith alone would not catch a
    // regression to a single newline, so pin the separator explicitly.
    expect(payload.content.startsWith(`${prefix} <@&111>\n\n[MAINNET]`)).toBe(true);
    expect(payload.content).toContain('[MAINNET] [CRITICAL] [UPGRADE]');
    expect(payload.content).toContain('**Upgrade now**');
    expect(payload.content).toContain('/a/slug-d');
    expect(payload.username).toBe('Aztec Announcements');
    expect(payload.allowed_mentions.roles).toContain('111');
  });

  it('works without a prefix configured', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:testnet-updates', 'discord', ${sql.json({ networks: ['testnet'], types: ['upgrade'], webhook_url: url })})`;
    await makeDiscordAdapter(sql).deliver(ann, 'discord:testnet-updates', 'publish');
    server.close();
    expect(JSON.parse(body).content.startsWith('[MAINNET]')).toBe(true);
  });

  it('omits the mention line when no role is selected', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, prefix, roles, username: 'Aztec Announcements' })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: [] }, 'discord:mainnet-updates', 'publish');
    server.close();

    expect(JSON.parse(body).content).not.toContain('<@&');
  });

  it('includes the mention line when a role is selected', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, prefix, roles, username: 'Aztec Announcements' })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: ['111'] }, 'discord:mainnet-updates', 'publish');
    server.close();

    expect(JSON.parse(body).content).toContain('<@&');
  });

  it('does not apply the prefix to an announcement authored before the selection column existed', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const prefix = 'Announcement:';
    const roles = [{ name: 'Mainnet', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, prefix, roles, username: 'Aztec Announcements' })})`;

    // A row written before migration 010 maps to mentionRoleIds: undefined —
    // the property is absent, not present-and-empty. That's the code
    // path `rowToAnnouncement` actually produces for legacy rows via `?? undefined`.
    const { mentionRoleIds: _omitted, ...legacy } = { ...ann, mentionRoleIds: ['111'] };
    await makeDiscordAdapter(sql).deliver(legacy, 'discord:mainnet-updates', 'publish');
    server.close();

    expect(JSON.parse(body).content).not.toContain('<@&');
  });

  it('mentions only the selected role', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const roles = [{ name: 'role-a', id: '111' }, { name: 'role-b', id: '222' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, roles })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: ['111'] }, 'discord:mainnet-updates', 'publish');
    server.close();

    const content = JSON.parse(body).content;
    expect(content).toContain('<@&111>');
    expect(content).not.toContain('<@&222>');
  });

  it('narrows allowed_mentions to the mentioned roles', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const roles = [{ name: 'role-a', id: '111' }, { name: 'role-b', id: '222' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, roles })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: ['111'] }, 'discord:mainnet-updates', 'publish');
    server.close();

    expect(JSON.parse(body).allowed_mentions).toEqual({ parse: [], roles: ['111'] });
  });

  it('permits nothing when no role is selected', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const roles = [{ name: 'role-a', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, roles })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: [] }, 'discord:mainnet-updates', 'publish');
    server.close();

    expect(JSON.parse(body).allowed_mentions).toEqual({ parse: [], roles: [] });
  });

  it('permits everyone only when everyone is selected', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: ['everyone'] }, 'discord:mainnet-updates', 'publish');
    server.close();

    expect(JSON.parse(body).allowed_mentions).toEqual({ parse: ['everyone'], roles: [] });
  });

  it('combines a built-in with a named role', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const roles = [{ name: 'role-a', id: '111' }];
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, roles })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: ['here', '111'] }, 'discord:mainnet-updates', 'publish');
    server.close();

    expect(JSON.parse(body).allowed_mentions).toEqual({ parse: ['everyone'], roles: ['111'] });
  });

  it('does not let a spliced prefix reconstruct into a posted, permitted mention', async () => {
    let body = '';
    const { server, url } = await listen((req, res) => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(204); res.end(); });
    });
    const roles = [{ name: 'role-a', id: '111' }];
    // This prefix has no whole match for the mention regex, but stripping the
    // inner <@&123> first would collapse the remainder into a live <@&456>
    // mention that was never configured and never selected.
    const prefix = '<@&<@&123>456>';
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, prefix, roles })})`;

    await makeDiscordAdapter(sql).deliver({ ...ann, mentionRoleIds: ['111'] }, 'discord:mainnet-updates', 'publish');
    server.close();

    const payload = JSON.parse(body);
    expect(payload.content).not.toContain('<@&456>');
    expect(payload.allowed_mentions.roles).not.toContain('456');
  });

  it('throws on unknown target so the worker retries', async () => {
    await expect(makeDiscordAdapter(sql).deliver(ann, 'discord:nope', 'publish'))
      .rejects.toThrow(/discord:nope/);
  });

  it('throws on a setting without webhook_url', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:broken', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'] })})`;
    await expect(makeDiscordAdapter(sql).deliver(ann, 'discord:broken', 'publish'))
      .rejects.toThrow(/webhook_url/);
  });

  it('throws on non-2xx', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(500); res.end(); });
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:err', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url })})`;
    await expect(makeDiscordAdapter(sql).deliver(ann, 'discord:err', 'publish')).rejects.toThrow(/500/);
    server.close();
  });
});
