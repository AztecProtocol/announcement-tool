import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
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

type Hit = { method: string; url: string; auth?: string; body: string };

function discordStub(opts: {
  webhook?: (res: ServerResponse) => void;
  channelType?: number;
  channelStatus?: number;
  channelRaw?: (res: ServerResponse) => void;
  crosspost?: (n: number, res: ServerResponse) => void;
} = {}): Promise<{ base: string; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = [];
  let crosspostCalls = 0;
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        hits.push({ method: req.method ?? '', url, auth: req.headers.authorization, body });
        if (url.startsWith('/webhook')) {
          if (opts.webhook) { opts.webhook(res); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: '111111111111111111', channel_id: '222222222222222222' }));
          return;
        }
        const chMatch = url.match(/^\/api\/channels\/([^/]+)$/);
        if (chMatch) {
          if (opts.channelRaw) { opts.channelRaw(res); return; }
          const status = opts.channelStatus ?? 200;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: opts.channelType ?? 5 }));
          return;
        }
        const cpMatch = url.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)\/crosspost$/);
        if (cpMatch) {
          crosspostCalls += 1;
          if (opts.crosspost) { opts.crosspost(crosspostCalls, res); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        base: `http://127.0.0.1:${port}`,
        hits,
        close: () => server.close(),
      });
    });
  });
}

async function seed(webhookUrl: string, extra: Record<string, unknown> = {}, key = 'discord:ann'): Promise<void> {
  await sql`insert into channel_settings (key, channel, config) values
    (${key}, 'discord', ${sql.json({ networks: ['mainnet'], types: ['upgrade'], webhook_url: webhookUrl, ...extra })})`;
}

describe('discord adapter — publish to followers', () => {
  it('1. announcement channel: posted and published', async () => {
    const { base, hits, close } = await discordStub({});
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'published' });
    expect(hits.map(h => h.method + ' ' + h.url)).toEqual([
      'POST /webhook?wait=true',
      'GET /api/channels/222222222222222222',
      'POST /api/channels/222222222222222222/messages/111111111111111111/crosspost',
    ]);
    expect(hits[0].auth).toBeUndefined();
    expect(hits[1].auth).toBe('Bot BOT-TOKEN-XYZ');
    expect(hits[2].auth).toBe('Bot BOT-TOKEN-XYZ');
  });

  it('2. text channel: posted, not published, no error', async () => {
    const { base, hits, close } = await discordStub({ channelType: 0 });
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'skipped: not an announcement channel' });
    expect(hits.some(h => h.url.includes('crosspost'))).toBe(false);
  });

  it('3. crosspost 403: delivery stands, one post only', async () => {
    const { base, hits, close } = await discordStub({
      crosspost: (_n, res) => { res.writeHead(403); res.end('{}'); },
    });
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: crosspost HTTP 403' });
    expect(hits.filter(h => h.url.startsWith('/webhook')).length).toBe(1);
  });

  it('4. 429 with a short retry_after: waits once, retries, published', async () => {
    const { base, hits, close } = await discordStub({
      crosspost: (n, res) => {
        if (n === 1) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ retry_after: 0.05 }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }
      },
    });
    await seed(`${base}/webhook`);
    const sleeps: number[] = [];
    const adapter = makeDiscordAdapter(sql, {
      botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'published' });
    expect(sleeps).toEqual([50]);
    expect(hits.filter(h => h.url.includes('crosspost')).length).toBe(2);
  });

  it('5. 429 with a long retry_after: failed, no second call', async () => {
    const { base, hits, close } = await discordStub({
      crosspost: (_n, res) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ retry_after: 3600 }));
      },
    });
    await seed(`${base}/webhook`);
    const sleeps: number[] = [];
    const adapter = makeDiscordAdapter(sql, {
      botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: rate limited (retry after 3600s)' });
    expect(hits.filter(h => h.url.includes('crosspost')).length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('6. no message id (204 with no body)', async () => {
    const { base, hits, close } = await discordStub({
      webhook: (res) => { res.writeHead(204); res.end(); },
    });
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: no message id' });
    expect(hits.filter(h => h.url.startsWith('/api')).length).toBe(0);
  });

  it('7. hostile ids never reach a URL', async () => {
    const { base, hits, close } = await discordStub({
      webhook: (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: '../../x', channel_id: '1/../../guilds' }));
      },
    });
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: no message id' });
    expect(hits.filter(h => h.url.startsWith('/api')).length).toBe(0);
  });

  it('8. no bot token: nothing changes on the wire', async () => {
    const { base, hits, close } = await discordStub({});
    await seed(`${base}/webhook`);
    const savedToken = process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    try {
      const adapter = makeDiscordAdapter(sql, { apiBase: `${base}/api`, sleep: async () => {} });
      const result = await adapter.deliver(ann, 'discord:ann', 'publish');
      expect(result).toEqual({ publishNote: 'skipped: no bot token' });
      expect(hits.length).toBe(1);
      expect(hits[0].url).toBe('/webhook');
      expect(hits[0].auth).toBeUndefined();
    } finally {
      if (savedToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = savedToken;
      close();
    }
  });

  it('9. auto_publish: false', async () => {
    const { base, hits, close } = await discordStub({});
    await seed(`${base}/webhook`, { auto_publish: false });
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'skipped: auto_publish is off' });
    expect(hits.length).toBe(1);
    expect(hits[0].url).toBe('/webhook');
  });

  it('10. channel lookup fails', async () => {
    const { base, hits, close } = await discordStub({ channelStatus: 403 });
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: channel lookup HTTP 403' });
    expect(hits.some(h => h.url.includes('crosspost'))).toBe(false);
  });

  it('11. API unreachable', async () => {
    const { base: webhookBase, hits, close } = await discordStub({});
    await seed(`${webhookBase}/webhook`);

    // Find a closed port: listen on 0, read it, close it.
    const closedPort: number = await new Promise(resolve => {
      const s = createServer(() => {});
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });

    const adapter = makeDiscordAdapter(sql, {
      botToken: 'BOT-TOKEN-XYZ', apiBase: `http://127.0.0.1:${closedPort}/api`, sleep: async () => {},
    });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect((result as { publishNote?: string })?.publishNote?.startsWith('failed: ')).toBe(true);
    expect(hits.filter(h => h.url.startsWith('/webhook')).length).toBe(1);
  });

  it('12. the token never leaks (tests 3, 5, 10, 11 notes)', async () => {
    const notes: string[] = [];

    const closedPort: number = await new Promise(resolve => {
      const s = createServer(() => {});
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });

    const stub403 = await discordStub({ crosspost: (_n, res) => { res.writeHead(403); res.end('{}'); } });
    const stub429 = await discordStub({
      crosspost: (_n, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ retry_after: 3600 })); },
    });
    const stubChannel403 = await discordStub({ channelStatus: 403 });
    const stubUnreachable = await discordStub({});

    await seed(`${stub403.base}/webhook`, {}, 'discord:leak-403');
    await seed(`${stub429.base}/webhook`, {}, 'discord:leak-429');
    await seed(`${stubChannel403.base}/webhook`, {}, 'discord:leak-channel-403');
    await seed(`${stubUnreachable.base}/webhook`, {}, 'discord:leak-unreachable');

    {
      const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${stub403.base}/api`, sleep: async () => {} });
      const r = await adapter.deliver(ann, 'discord:leak-403', 'publish');
      notes.push((r as { publishNote?: string })?.publishNote ?? '');
    }
    {
      const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${stub429.base}/api`, sleep: async () => {} });
      const r = await adapter.deliver(ann, 'discord:leak-429', 'publish');
      notes.push((r as { publishNote?: string })?.publishNote ?? '');
    }
    {
      const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${stubChannel403.base}/api`, sleep: async () => {} });
      const r = await adapter.deliver(ann, 'discord:leak-channel-403', 'publish');
      notes.push((r as { publishNote?: string })?.publishNote ?? '');
    }
    {
      const adapter = makeDiscordAdapter(sql, {
        botToken: 'BOT-TOKEN-XYZ', apiBase: `http://127.0.0.1:${closedPort}/api`, sleep: async () => {},
      });
      const r = await adapter.deliver(ann, 'discord:leak-unreachable', 'publish');
      notes.push((r as { publishNote?: string })?.publishNote ?? '');
    }

    stub403.close();
    stub429.close();
    stubChannel403.close();
    stubUnreachable.close();

    for (const note of notes) {
      expect(note).not.toContain('BOT-TOKEN-XYZ');
    }
  });

  it('13. a webhook URL that already has a query keeps it', async () => {
    const { base, hits, close } = await discordStub({});
    await seed(`${base}/webhook?thread_id=9`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(hits[0].url).toBe('/webhook?thread_id=9&wait=true');
  });

  it('14. channel lookup returns a 2xx with a non-JSON (HTML) body', async () => {
    const { base, hits, close } = await discordStub({
      channelRaw: (res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Cloudflare</html>'); },
    });
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: channel lookup returned no JSON' });
    expect(hits.some(h => h.url.includes('crosspost'))).toBe(false);
  });

  it('15. a thrown fetch error naming the token is redacted before it reaches the ledger', async () => {
    const { base, close } = await discordStub({});
    await seed(`${base}/webhook`);
    const throwingFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(`${base}/webhook`)) return fetch(input, init);
      throw new Error('boom Bot BOT-TOKEN-XYZ boom');
    }) as typeof fetch;
    const adapter = makeDiscordAdapter(sql, {
      botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {}, fetchImpl: throwingFetch,
    });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: boom Bot *** boom' });
    expect((result as { publishNote: string }).publishNote).not.toContain('BOT-TOKEN-XYZ');
  });

  it('16. an insecure (plaintext http, non-local) api base is refused before any request', async () => {
    const { base, hits, close } = await discordStub({});
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, {
      botToken: 'BOT-TOKEN-XYZ', apiBase: 'http://example.com/api', sleep: async () => {},
    });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: insecure api base' });
    expect(hits.filter(h => h.url.startsWith('/api')).length).toBe(0);
  });

  it('17. a redirect from the channel lookup is refused, not followed', async () => {
    const { base: otherBase, hits: otherHits, close: closeOther } = await discordStub({});
    const { base, hits, close } = await discordStub({
      channelRaw: (res) => { res.writeHead(302, { location: `${otherBase}/x` }); res.end(); },
    });
    await seed(`${base}/webhook`);
    const adapter = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`, sleep: async () => {} });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();
    closeOther();

    expect((result as { publishNote?: string })?.publishNote?.startsWith('failed: ')).toBe(true);
    expect(otherHits.length).toBe(0);
  });

  it('18. byte-identical delivery with and without a bot token, aside from the URL', async () => {
    const { base: baseA, hits: hitsA, close: closeA } = await discordStub({});
    const { base: baseB, hits: hitsB, close: closeB } = await discordStub({});
    await seed(`${baseA}/webhook`, {}, 'discord:with-token');
    await seed(`${baseB}/webhook`, {}, 'discord:without-token');

    const savedToken = process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    try {
      const withToken = makeDiscordAdapter(sql, { botToken: 'BOT-TOKEN-XYZ', apiBase: `${baseA}/api`, sleep: async () => {} });
      await withToken.deliver(ann, 'discord:with-token', 'publish');

      const withoutToken = makeDiscordAdapter(sql, { apiBase: `${baseB}/api`, sleep: async () => {} });
      await withoutToken.deliver(ann, 'discord:without-token', 'publish');
    } finally {
      if (savedToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = savedToken;
      closeA();
      closeB();
    }

    expect(hitsA[0].url).toBe('/webhook?wait=true');
    expect(hitsB[0].url).toBe('/webhook');
    expect(hitsA[0].body).toBe(hitsB[0].body);
  });

  it('19. crosspost 429 with a fractional retry_after rounds up in the note', async () => {
    const { base, hits, close } = await discordStub({
      crosspost: (_n, res) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ retry_after: 10.5 }));
      },
    });
    await seed(`${base}/webhook`);
    const sleeps: number[] = [];
    const adapter = makeDiscordAdapter(sql, {
      botToken: 'BOT-TOKEN-XYZ', apiBase: `${base}/api`,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    const result = await adapter.deliver(ann, 'discord:ann', 'publish');
    close();

    expect(result).toEqual({ publishNote: 'failed: rate limited (retry after 11s)' });
    expect(hits.filter(h => h.url.includes('crosspost')).length).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
