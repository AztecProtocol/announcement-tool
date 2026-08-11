import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { startEmailSubscription, confirmSubscription } from '../src/core/subscribe-flow.js';
import { getSubscription } from '../src/core/subscriptions.js';
import type { EmailMessage, EmailSender } from '../src/adapters/esp.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

function recorder(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, sender: { name: 'test', async send(m) { sent.push(m); } } };
}

describe('email double-opt-in', () => {
  it('new address: creates unverified sub and sends a confirmation link', async () => {
    const { sender, sent } = recorder();
    const res = await startEmailSubscription(sql, sender, {
      email: 'new@example.com', filters: { severities: ['critical'] }, baseUrl: 'https://announce.example',
    });
    expect(res).toBe('confirmation_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('new@example.com');
    const m = sent[0].text.match(/https:\/\/announce\.example\/confirm\/([0-9a-f]{32})/);
    expect(m).not.toBeNull();

    const confirmed = await confirmSubscription(sql, m![1]);
    expect(confirmed?.endpoint).toBe('new@example.com');
    expect((await getSubscription(sql, confirmed!.id))!.verified).toBe(true);
  });

  it('re-subscribing an unverified address updates filters and re-sends confirmation', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'p@example.com' });
    const res = await startEmailSubscription(sql, sender, { email: 'p@example.com', filters: { severities: ['critical'] } });
    expect(res).toBe('confirmation_sent');
    expect(sent).toHaveLength(2);
    const [row] = await sql`select filter_severities, verified from subscriptions where endpoint = 'p@example.com'`;
    expect(row.filter_severities).toEqual(['critical']);
    expect(row.verified).toBe(false);
  });

  it('re-subscribing a verified address updates filters, sends a notice, stays verified', async () => {
    const { sender, sent } = recorder();
    await startEmailSubscription(sql, sender, { email: 'v@example.com' });
    const token = sent[0].text.match(/\/confirm\/([0-9a-f]{32})/)![1];
    await confirmSubscription(sql, token);

    const res = await startEmailSubscription(sql, sender, { email: 'v@example.com', filters: { networks: ['mainnet'] } });
    expect(res).toBe('updated');
    expect(sent).toHaveLength(2);
    expect(sent[1].subject.toLowerCase()).toContain('updated');
    const [row] = await sql`select filter_networks, verified from subscriptions where endpoint = 'v@example.com'`;
    expect(row.filter_networks).toEqual(['mainnet']);
    expect(row.verified).toBe(true);
  });

  it('confirming an unknown token returns undefined', async () => {
    expect(await confirmSubscription(sql, 'a'.repeat(32))).toBeUndefined();
  });
});
