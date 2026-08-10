import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { makeResendSender, makeBrevoSender, makeConsoleSender, senderFromEnv } from '../src/adapters/esp.js';

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const msg = { to: 'ops@example.com', subject: 'S', text: 'B', headers: { 'List-Unsubscribe': '<https://x/u>' } };
const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe('resend sender', () => {
  it('posts to /emails with bearer auth and text body', async () => {
    let auth = '', path = '', body = '';
    const { server, base } = await listen((req, res) => {
      auth = req.headers.authorization ?? ''; path = req.url ?? '';
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(200); res.end('{}'); });
    });
    await makeResendSender({ apiKey: 'RK', from: 'Aztec <no-reply@announce.example>', apiBase: base }).send(msg);
    server.close();
    expect(auth).toBe('Bearer RK');
    expect(path).toBe('/emails');
    const p = JSON.parse(body);
    expect(p.to).toEqual(['ops@example.com']);
    expect(p.text).toBe('B');
    expect(p.headers['List-Unsubscribe']).toBe('<https://x/u>');
  });

  it('throws with the response body on non-2xx', async () => {
    const { server, base } = await listen((_req, res) => { res.writeHead(422); res.end('domain not verified'); });
    await expect(makeResendSender({ apiKey: 'RK', from: 'a@b.c', apiBase: base }).send(msg))
      .rejects.toThrow(/domain not verified/);
    server.close();
  });

  it('throws without an api key', async () => {
    delete process.env.RESEND_API_KEY;
    await expect(makeResendSender({ from: 'a@b.c' }).send(msg)).rejects.toThrow(/RESEND_API_KEY/);
  });
});

describe('brevo sender', () => {
  it('posts to /v3/smtp/email with api-key header and textContent', async () => {
    let key = '', path = '', body = '';
    const { server, base } = await listen((req, res) => {
      key = (req.headers['api-key'] as string) ?? ''; path = req.url ?? '';
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { body = d; res.writeHead(201); res.end('{}'); });
    });
    await makeBrevoSender({ apiKey: 'BK', from: 'no-reply@announce.example', fromName: 'Aztec', apiBase: base }).send(msg);
    server.close();
    expect(key).toBe('BK');
    expect(path).toBe('/v3/smtp/email');
    const p = JSON.parse(body);
    expect(p.sender).toEqual({ email: 'no-reply@announce.example', name: 'Aztec' });
    expect(p.to).toEqual([{ email: 'ops@example.com' }]);
    expect(p.textContent).toBe('B');
  });
});

describe('senderFromEnv', () => {
  it('defaults to the console sender', () => {
    delete process.env.ESP_PROVIDER;
    expect(senderFromEnv().name).toBe('console');
  });
  it('selects resend and brevo by env', () => {
    process.env.ESP_PROVIDER = 'resend'; process.env.RESEND_API_KEY = 'k'; process.env.EMAIL_FROM = 'a@b.c';
    expect(senderFromEnv().name).toBe('resend');
    process.env.ESP_PROVIDER = 'brevo'; process.env.BREVO_API_KEY = 'k';
    expect(senderFromEnv().name).toBe('brevo');
  });
  it('rejects an unknown provider', () => {
    process.env.ESP_PROVIDER = 'mailgun';
    expect(() => senderFromEnv()).toThrow(/mailgun/);
  });
  it('console sender resolves without throwing', async () => {
    await expect(makeConsoleSender().send(msg)).resolves.toBeUndefined();
  });
});
