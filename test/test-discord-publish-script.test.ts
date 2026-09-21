import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/test-discord-publish.ts');
const REPO_ROOT = resolve(__dirname, '..');

type Hit = { method: string; url: string; auth?: string; body: string };

function discordStub(): Promise<{ base: string; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = [];
  let crosspostCalls = 0;
  return new Promise(resolve => {
    const server: Server = createServer((req, res) => {
      const url = req.url ?? '';
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        hits.push({ method: req.method ?? '', url, auth: req.headers.authorization, body });
        if (url.startsWith('/webhook')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: '111111111111111111', channel_id: '222222222222222222' }));
          return;
        }
        if (url === '/api/channels/222222222222222222') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 5 }));
          return;
        }
        if (url === '/api/channels/222222222222222222/messages/111111111111111111/crosspost') {
          crosspostCalls += 1;
          if (crosspostCalls === 1) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
          } else {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ code: 40033, message: 'This message has already been crossposted.' }));
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, hits, close: () => server.close() });
    });
  });
}

function run(env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npx', ['tsx', SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

describe('scripts/test-discord-publish.ts', () => {
  it('posts, publishes, and shows the second-crosspost answer, without leaking the token or the webhook path', async () => {
    const { base, hits, close } = await discordStub();
    try {
      const { code, stdout, stderr } = await run({
        WEBHOOK_URL: `${base}/webhook`,
        DISCORD_BOT_TOKEN: 'BOT-TOKEN-XYZ',
        DISCORD_PUBLISH_TEST_STUB: '1',
        DISCORD_API_BASE_OVERRIDE: `${base}/api`,
      });

      expect(code).toBe(0);
      expect(stdout).toContain('publish: published');
      expect(stdout).toContain('second publish of the same message: HTTP 400');
      expect(stdout).toContain('40033');
      expect(stdout).not.toContain('BOT-TOKEN-XYZ');
      expect(stderr).not.toContain('BOT-TOKEN-XYZ');
      expect(stdout).not.toContain('/webhook');
      expect(stderr).not.toContain('/webhook');

      const webhookHits = hits.filter(h => h.url.startsWith('/webhook'));
      expect(webhookHits.length).toBe(1);
      expect(webhookHits[0].url).toContain('wait=true');

      const crosspostHits = hits.filter(h => h.url.includes('/crosspost'));
      expect(crosspostHits.length).toBe(2);
      for (const h of crosspostHits) expect(h.auth).toBe('Bot BOT-TOKEN-XYZ');
    } finally {
      close();
    }
  }, 30_000);

  it('missing env: exits 2 with usage text', async () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.WEBHOOK_URL;
    delete env.DISCORD_BOT_TOKEN;
    const { code, stderr } = await run(env);
    expect(code).toBe(2);
    expect(stderr.toLowerCase()).toContain('usage');
  }, 30_000);

  it('a non-discord WEBHOOK_URL is refused before any request', async () => {
    const { code, stderr } = await run({
      WEBHOOK_URL: 'https://example.com/x',
      DISCORD_BOT_TOKEN: 'BOT-TOKEN-XYZ',
    });
    expect(code).toBe(2);
    expect(stderr).toContain('WEBHOOK_URL must be a discord.com webhook');
  }, 30_000);
});
