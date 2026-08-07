import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { signPayload, assertDeliverableUrl, makeWebhookAdapter } from '../src/adapters/webhook.js';
import { createSubscription, verifySubscription } from '../src/core/subscriptions.js';
import type { Announcement } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const ann: Announcement = {
  id: 'ann_T', revision: 1, slug: 's', type: 'upgrade', networks: ['mainnet'], audiences: ['operators'],
  severity: 'critical', title: 'T', bodyMd: 'B', actionsRequired: [], links: [], status: 'published', createdBy: 'a@x',
};

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/hook` });
    });
  });
}

describe('signPayload', () => {
  it('is hmac-sha256 of "timestamp.body"', () => {
    const expected = createHmac('sha256', 'sec').update('123.{}').digest('hex');
    expect(signPayload('sec', '123', '{}')).toBe(expected);
  });
});

describe('assertDeliverableUrl', () => {
  it('blocks http, localhost, private and link-local ranges', () => {
    for (const bad of ['http://example.com/h', 'https://localhost/h', 'https://127.0.0.1/h',
      'https://10.0.0.5/h', 'https://192.168.1.1/h', 'https://172.16.0.1/h', 'https://169.254.1.1/h',
      'https://internal.local/h']) {
      expect(() => assertDeliverableUrl(bad)).toThrow();
    }
    expect(() => assertDeliverableUrl('https://ops.example.com/h')).not.toThrow();
    expect(() => assertDeliverableUrl('http://127.0.0.1/h', true)).not.toThrow();
  });
});

describe('makeWebhookAdapter', () => {
  it('POSTs signed payload; receiver can verify the signature', async () => {
    let seen: { body: string; headers: Record<string, string | string[] | undefined> } | undefined;
    const { server, url } = await listen((req, res) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => { seen = { body: data, headers: req.headers }; res.writeHead(200); res.end(); });
    });
    const sub = await createSubscription(sql, { channel: 'webhook', endpoint: url });
    await verifySubscription(sql, sub.id);

    const adapter = makeWebhookAdapter(sql, { allowPrivateHosts: true });
    await adapter.deliver(ann, sub.id, 'publish');
    server.close();

    expect(seen).toBeDefined();
    const payload = JSON.parse(seen!.body);
    expect(payload.event_id).toBe('ann_T.1.publish');
    expect(payload.announcement.severity).toBe('critical');
    const ts = seen!.headers['x-announce-timestamp'] as string;
    const sig = (seen!.headers['x-announce-signature'] as string).replace('v1=', '');
    expect(sig).toBe(signPayload(sub.secret!, ts, seen!.body));
  });

  it('throws on non-2xx so the worker retries', async () => {
    const { server, url } = await listen((_req, res) => { res.writeHead(500); res.end(); });
    const sub = await createSubscription(sql, { channel: 'webhook', endpoint: url });
    await verifySubscription(sql, sub.id);
    const adapter = makeWebhookAdapter(sql, { allowPrivateHosts: true });
    await expect(adapter.deliver(ann, sub.id, 'publish')).rejects.toThrow(/500/);
    server.close();
  });
});
