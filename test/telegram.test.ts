import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { makeTelegramAdapter } from '../src/adapters/telegram.js';
import type { Announcement } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const ann: Announcement = {
  id: 'ann_T', revision: 1, slug: 'slug-t', type: 'governance', networks: ['mainnet', 'testnet'],
  audiences: ['operators'], severity: 'recommended', title: 'AZIP-7 signaling open',
  bodyMd: 'Signal before Friday (deadline 14:00).', actionsRequired: [], links: [],
  status: 'published', createdBy: 'a@x',
};

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe('telegram adapter', () => {
  it('sends plain text to the configured chat via the bot token path', async () => {
    let path = '', body = '';
    const { server, base } = await listen((req, res) => {
      path = req.url ?? ''; let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: {} })); });
    });
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:main', 'telegram', ${sql.json({ networks: ['mainnet', 'testnet'], types: ['upgrade', 'governance', 'info'], chat_id: '@AztecAnnouncements' })})`;

    const adapter = makeTelegramAdapter(sql, { apiBase: base, botToken: 'TESTTOKEN' });
    await adapter.deliver(ann, 'telegram:main', 'publish');
    server.close();

    expect(path).toBe('/botTESTTOKEN/sendMessage');
    const payload = JSON.parse(body);
    expect(payload.chat_id).toBe('@AztecAnnouncements');
    expect(payload.parse_mode).toBeUndefined(); // plain text — no escaping hazard
    expect(payload.disable_web_page_preview).toBe(true);
    expect(payload.text).toContain('[MAINNET] [TESTNET] [RECOMMENDED] [GOVERNANCE]');
    expect(payload.text).toContain('AZIP-7 signaling open');
    expect(payload.text).toContain('/a/slug-t');
  });

  it('throws when telegram replies ok:false despite HTTP 200', async () => {
    const { server, base } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'chat not found' }));
    });
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:main', 'telegram', ${sql.json({ chat_id: '@nope' })})`;
    await expect(makeTelegramAdapter(sql, { apiBase: base, botToken: 'T' }).deliver(ann, 'telegram:main', 'publish'))
      .rejects.toThrow(/chat not found/);
    server.close();
  });

  it('throws without a bot token', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:main', 'telegram', ${sql.json({ chat_id: '@x' })})`;
    await expect(makeTelegramAdapter(sql, { apiBase: 'http://127.0.0.1:1', botToken: '' }).deliver(ann, 'telegram:main', 'publish'))
      .rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws on a setting without chat_id', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:broken', 'telegram', ${sql.json({ networks: ['mainnet'] })})`;
    await expect(makeTelegramAdapter(sql, { botToken: 'T' }).deliver(ann, 'telegram:broken', 'publish'))
      .rejects.toThrow(/chat_id/);
  });

  it('throws on unknown target (missing settings row)', async () => {
    await expect(makeTelegramAdapter(sql, { botToken: 'T' }).deliver(ann, 'telegram:nope', 'publish'))
      .rejects.toThrow(/telegram:nope/);
  });

  it('never leaks bot token in HTTP 200 ok:false error', async () => {
    const { server, base } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'auth failed' }));
    });
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:main', 'telegram', ${sql.json({ chat_id: '@test' })})`;
    try {
      await makeTelegramAdapter(sql, { apiBase: base, botToken: 'SUPERSECRETTOKEN' }).deliver(ann, 'telegram:main', 'publish');
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain('SUPERSECRETTOKEN');
    }
    server.close();
  });

  it('never leaks bot token in HTTP error', async () => {
    const { server, base } = await listen((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await sql`insert into channel_settings (key, channel, config) values
      ('telegram:main', 'telegram', ${sql.json({ chat_id: '@test' })})`;
    try {
      await makeTelegramAdapter(sql, { apiBase: base, botToken: 'SUPERSECRETTOKEN' }).deliver(ann, 'telegram:main', 'publish');
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain('SUPERSECRETTOKEN');
    }
    server.close();
  });
});
