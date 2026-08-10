import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { makeSignalAdapter } from '../src/adapters/signal.js';
import type { Announcement } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const ann: Announcement = {
  id: 'ann_S', revision: 1, slug: 'slug-s', type: 'upgrade', networks: ['mainnet'],
  audiences: ['operators'], severity: 'critical', title: 'Upgrade now', bodyMd: 'Body.',
  actionsRequired: [], links: [], status: 'published', createdBy: 'a@x',
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

describe('signal adapter', () => {
  it('posts the plain message to /v2/send for the configured group', async () => {
    let path = '', body = '';
    const { server, base } = await listen((req, res) => {
      path = req.url ?? ''; let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(201); res.end('{"timestamp":"1"}'); });
    });
    await sql`insert into channel_settings (key, channel, config) values
      ('signal:main', 'signal', ${sql.json({ networks: ['mainnet', 'testnet'], types: ['upgrade', 'governance', 'info'], group_id: 'group.abc123' })})`;

    await makeSignalAdapter(sql, { apiBase: base, account: '+15550000000' })
      .deliver(ann, 'signal:main', 'publish');
    server.close();

    expect(path).toBe('/v2/send');
    const p = JSON.parse(body);
    expect(p.number).toBe('+15550000000');
    expect(p.recipients).toEqual(['group.abc123']);
    expect(p.message).toContain('[MAINNET] [CRITICAL] [UPGRADE]');
    expect(p.message).toContain('/a/slug-s');
  });

  it('throws with the response body when signal-cli fails', async () => {
    const { server, base } = await listen((_req, res) => { res.writeHead(400); res.end('Unregistered user'); });
    await sql`insert into channel_settings (key, channel, config) values
      ('signal:main', 'signal', ${sql.json({ group_id: 'group.abc' })})`;
    await expect(makeSignalAdapter(sql, { apiBase: base, account: '+1' }).deliver(ann, 'signal:main', 'publish'))
      .rejects.toThrow(/Unregistered user/);
    server.close();
  });

  it('throws without an account or group_id', async () => {
    await sql`insert into channel_settings (key, channel, config) values
      ('signal:main', 'signal', ${sql.json({ group_id: 'g' })}),
      ('signal:broken', 'signal', ${sql.json({})})`;
    await expect(makeSignalAdapter(sql, { apiBase: 'http://127.0.0.1:1', account: '' }).deliver(ann, 'signal:main', 'publish'))
      .rejects.toThrow(/SIGNAL_ACCOUNT/);
    await expect(makeSignalAdapter(sql, { apiBase: 'http://127.0.0.1:1', account: '+1' }).deliver(ann, 'signal:broken', 'publish'))
      .rejects.toThrow(/group_id/);
  });
});
