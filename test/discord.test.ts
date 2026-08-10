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
    const prefix = '@here <:AztecDiscordEmoji_A:1> <@&Mainnet> <@&Genesis>';
    await sql`insert into channel_settings (key, channel, config) values
      ('discord:mainnet-updates', 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: url, prefix, username: 'Aztec Announcements' })})`;

    const adapter = makeDiscordAdapter(sql);
    await adapter.deliver(ann, 'discord:mainnet-updates', 'publish');
    server.close();

    const payload = JSON.parse(body);
    expect(payload.content.startsWith(prefix)).toBe(true);
    expect(payload.content).toContain('[MAINNET] [CRITICAL] [UPGRADE]');
    expect(payload.content).toContain('**Upgrade now**');
    expect(payload.content).toContain('/a/slug-d');
    expect(payload.username).toBe('Aztec Announcements');
    expect(payload.allowed_mentions.parse).toContain('roles');
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
