import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { alertKey, dispatchHealthAlerts } from '../src/core/alerts.js';
import type { EmailMessage, EmailSender } from '../src/adapters/esp.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => {
  await resetDb(sql);
  await sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by, published_at)
    values ('ann_A', 1, 's', 'upgrade', '{mainnet}', '{operators}', 'critical', 'T', 'b', 'published', 'a@x', now())`;
  await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, attempts, last_error, next_attempt_at)
    values ('ann_A', 1, 'publish', 'signal', 'signal:main', 'exhausted', 5, 'Unregistered user', now())`;
});
afterAll(async () => { await sql.end(); });

function recorder(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, sender: { name: 'test', async send(m) { sent.push(m); } } };
}

describe('dispatchHealthAlerts', () => {
  it('alerts once for a new issue and never again', async () => {
    const { sender, sent } = recorder();
    const first = await dispatchHealthAlerts(sql, sender, { to: 'ops@aztec.foundation' });
    expect(first.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ops@aztec.foundation');
    expect(sent[0].subject).toContain('channel health');
    expect(sent[0].text).toContain('signal');
    expect(sent[0].text).toContain('Unregistered user');

    const second = await dispatchHealthAlerts(sql, sender, { to: 'ops@aztec.foundation' });
    expect(second).toEqual([]);
    expect(sent).toHaveLength(1); // no repeat on the next tick
  });

  it('records one alert_state row per issue key', async () => {
    const { sender } = recorder();
    const issues = await dispatchHealthAlerts(sql, sender, { to: 'ops@aztec.foundation' });
    const rows = await sql`select key, notified_at from alert_state order by key`;
    expect(rows.length).toBe(issues.length);
    expect(rows.every(r => r.notified_at !== null)).toBe(true);
    expect(rows.map(r => r.key)).toContain(alertKey(issues[0]));
  });

  it('alerts again for a genuinely different issue', async () => {
    const { sender, sent } = recorder();
    await dispatchHealthAlerts(sql, sender, { to: 'ops@aztec.foundation' });
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, attempts, last_error, next_attempt_at)
      values ('ann_A', 1, 'publish', 'telegram', 'telegram:main', 'exhausted', 5, 'chat not found', now())`;
    const more = await dispatchHealthAlerts(sql, sender, { to: 'ops@aztec.foundation' });
    expect(more.some(i => i.channel === 'telegram')).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('sends nothing and records nothing when no recipient is configured', async () => {
    const saved = process.env.ALERT_EMAIL_TO;
    delete process.env.ALERT_EMAIL_TO;
    const { sender, sent } = recorder();
    const res = await dispatchHealthAlerts(sql, sender);
    expect(res).toEqual([]);
    expect(sent).toHaveLength(0);
    const [{ c }] = await sql`select count(*)::int as c from alert_state`;
    expect(c).toBe(0);
    if (saved !== undefined) process.env.ALERT_EMAIL_TO = saved;
  });

  it('reports two distinct issues for two targets on the same channel, not a collision', async () => {
    // Same announcement, same channel (discord), two different per-topic targets both
    // exhausted — must not collapse into a single alert_state key / single reported issue.
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, attempts, last_error, next_attempt_at)
      values ('ann_A', 1, 'publish', 'discord', 'discord:mainnet-updates', 'exhausted', 5, 'webhook gone', now())`;
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, status, attempts, last_error, next_attempt_at)
      values ('ann_A', 1, 'publish', 'discord', 'discord:testnet-updates', 'exhausted', 5, 'webhook gone too', now())`;

    const { sender, sent } = recorder();
    const issues = await dispatchHealthAlerts(sql, sender, { to: 'ops@aztec.foundation' });

    const discordIssues = issues.filter(i => i.channel === 'discord');
    expect(discordIssues).toHaveLength(2);
    expect(new Set(discordIssues.map(alertKey)).size).toBe(2);

    const rows = await sql`select key from alert_state where key like 'exhausted:discord:%'`;
    expect(rows).toHaveLength(2);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('discord:mainnet-updates');
    expect(sent[0].text).toContain('discord:testnet-updates');
  });

  it('does not swallow a failing sender', async () => {
    const failing: EmailSender = { name: 'boom', async send() { throw new Error('ESP down'); } };
    await expect(dispatchHealthAlerts(sql, failing, { to: 'ops@aztec.foundation' })).rejects.toThrow(/ESP down/);
  });

  it('leaves the row un-notified after a failed send, so it is retried later', async () => {
    const failing: EmailSender = { name: 'boom', async send() { throw new Error('ESP down'); } };
    await expect(dispatchHealthAlerts(sql, failing, { to: 'ops@aztec.foundation' })).rejects.toThrow(/ESP down/);

    const rows = await sql`select key, notified_at from alert_state`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.notified_at === null)).toBe(true);

    const { sender, sent } = recorder();
    const retried = await dispatchHealthAlerts(sql, sender, { to: 'ops@aztec.foundation' });
    expect(retried.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    const rowsAfter = await sql`select key, notified_at from alert_state`;
    expect(rowsAfter.every(r => r.notified_at !== null)).toBe(true);
  });
});
