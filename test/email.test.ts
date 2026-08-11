import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { makeEmailAdapter } from '../src/adapters/email.js';
import type { EmailMessage, EmailSender } from '../src/adapters/esp.js';
import { createSubscription, verifySubscription } from '../src/core/subscriptions.js';
import type { Announcement } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const ann: Announcement = {
  id: 'ann_E', revision: 1, slug: 'slug-e', type: 'upgrade', networks: ['mainnet'],
  audiences: ['operators'], severity: 'critical', title: 'Upgrade to v5.1.0', bodyMd: 'Body.',
  actionsRequired: [], links: [], status: 'published', createdBy: 'a@x',
};

function recorder(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, sender: { name: 'test', async send(m) { sent.push(m); } } };
}

describe('email adapter', () => {
  it('sends the rendered email with a real unsubscribe url and one-click headers', async () => {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: 'ops@example.com' });
    await verifySubscription(sql, sub.id);
    const { sender, sent } = recorder();

    await makeEmailAdapter(sql, sender, { baseUrl: 'https://announce.example' })
      .deliver(ann, sub.id, 'publish');

    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.to).toBe('ops@example.com');
    expect(m.subject).toBe('[MAINNET] [CRITICAL] [UPGRADE] Upgrade to v5.1.0');
    expect(m.text).toContain(`https://announce.example/u/${sub.unsubscribeToken}`);
    expect(m.text).not.toContain('{{UNSUBSCRIBE}}');
    expect(m.html).toContain(`https://announce.example/u/${sub.unsubscribeToken}`);
    expect(m.html).not.toContain('{{UNSUBSCRIBE}}');
    expect(m.html).toContain('<h1');
    expect(m.headers?.['List-Unsubscribe']).toBe(`<https://announce.example/u/${sub.unsubscribeToken}>`);
    expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('refuses to send to an unverified subscription', async () => {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: 'nope@example.com' });
    const { sender, sent } = recorder();
    await expect(makeEmailAdapter(sql, sender).deliver(ann, sub.id, 'publish')).rejects.toThrow(/unverified/);
    expect(sent).toHaveLength(0);
  });

  it('throws on unknown subscription', async () => {
    const { sender } = recorder();
    await expect(makeEmailAdapter(sql, sender).deliver(ann, 'sub_missing', 'publish')).rejects.toThrow(/sub_missing/);
  });

  it('propagates sender failures so the worker retries', async () => {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: 'ops2@example.com' });
    await verifySubscription(sql, sub.id);
    const failing: EmailSender = { name: 'boom', async send() { throw new Error('ESP down'); } };
    await expect(makeEmailAdapter(sql, failing).deliver(ann, sub.id, 'publish')).rejects.toThrow(/ESP down/);
  });

  it('marks reminder sends in the subject', async () => {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: 'ops3@example.com' });
    await verifySubscription(sql, sub.id);
    const { sender, sent } = recorder();
    await makeEmailAdapter(sql, sender).deliver(ann, sub.id, 'reminder');
    expect(sent[0].subject.startsWith('REMINDER: ')).toBe(true);
  });
});
