import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { createDraft, requestPublish, confirmPublish, FourEyesError } from '../src/core/announcements.js';
import { createSubscription, verifySubscription } from '../src/core/subscriptions.js';
import { countFanoutTargets } from '../src/core/outbox.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => {
  await resetDb(sql);
  await sql`insert into channel_settings (key, channel, config) values
    ('discord:mainnet-updates', 'discord', '{"networks":["mainnet"],"types":["upgrade","info"],"webhook_url":"http://x"}'),
    ('discord:governance-updates', 'discord', '{"networks":["mainnet","testnet"],"types":["governance"],"webhook_url":"http://x"}'),
    ('telegram:main', 'telegram', '{"networks":["mainnet","testnet"],"types":["upgrade","governance","info"],"chat_id":"@x"}')`;
});
afterAll(async () => { await sql.end(); });

const critical: AnnouncementInput = {
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.1.0', bodyMd: 'Do it.', actionsRequired: [],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
};

describe('publish flow', () => {
  it('critical requires a second person; same actor is rejected', async () => {
    const a = await createDraft(sql, critical, 'alice@x');
    const requested = await requestPublish(sql, a.id, 'alice@x');
    expect(requested.status).toBe('publish_requested');
    await expect(confirmPublish(sql, a.id, 'alice@x')).rejects.toThrow(FourEyesError);
    const done = await confirmPublish(sql, a.id, 'bob@x');
    expect(done.status).toBe('published');
  });

  it('non-critical publishes immediately on request', async () => {
    const a = await createDraft(sql, { ...critical, severity: 'info', type: 'info', links: [] }, 'alice@x');
    const done = await requestPublish(sql, a.id, 'alice@x');
    expect(done.status).toBe('published');
  });

  it('publish enqueues broadcast + matching verified subscriptions only, atomically', async () => {
    const hit = await createSubscription(sql, { channel: 'webhook', endpoint: 'https://a.example.com/h', filters: { severities: ['critical'] } });
    await verifySubscription(sql, hit.id);
    await createSubscription(sql, { channel: 'webhook', endpoint: 'https://unverified.example.com/h' }); // never verified
    const miss = await createSubscription(sql, { channel: 'email', endpoint: 'x@y.z', filters: { networks: ['testnet'] } });
    await verifySubscription(sql, miss.id);

    const a = await createDraft(sql, critical, 'alice@x');
    await requestPublish(sql, a.id, 'alice@x');
    await confirmPublish(sql, a.id, 'bob@x');

    const rows = await sql`select channel, target from delivery_ledger where announcement_id = ${a.id} order by channel, target`;
    // discord mainnet-updates (upgrade+mainnet matches), telegram:main, and the one matching verified webhook sub.
    // NOT discord:governance-updates (type mismatch), NOT the unverified or testnet-only subs.
    expect(rows).toEqual([
      { channel: 'discord', target: 'discord:mainnet-updates' },
      { channel: 'telegram', target: 'telegram:main' },
      { channel: 'webhook', target: hit.id },
    ]);
  });

  it('countFanoutTargets matches exactly what enqueueDeliveries writes', async () => {
    const hit = await createSubscription(sql, { channel: 'webhook', endpoint: 'https://a.example.com/h', filters: { severities: ['critical'] } });
    await verifySubscription(sql, hit.id);
    await createSubscription(sql, { channel: 'webhook', endpoint: 'https://unverified.example.com/h' }); // never verified
    const miss = await createSubscription(sql, { channel: 'email', endpoint: 'x@y.z', filters: { networks: ['testnet'] } });
    await verifySubscription(sql, miss.id);

    const a = await createDraft(sql, critical, 'alice@x');

    const preview = await countFanoutTargets(sql, a);

    await requestPublish(sql, a.id, 'alice@x');
    await confirmPublish(sql, a.id, 'bob@x');

    const rows = await sql`select channel, target from delivery_ledger where announcement_id = ${a.id} order by channel, target`;
    const sortedPreview = [...preview].sort((x, y) => x.channel.localeCompare(y.channel) || x.target.localeCompare(y.target));
    expect(sortedPreview).toEqual(rows.map(r => ({ channel: r.channel, target: r.target })));
  });

  it('double confirm does not duplicate ledger rows', async () => {
    const a = await createDraft(sql, critical, 'alice@x');
    await requestPublish(sql, a.id, 'alice@x');
    await confirmPublish(sql, a.id, 'bob@x');
    await expect(confirmPublish(sql, a.id, 'bob@x')).rejects.toThrow(/not awaiting confirmation/);
    const [{ c }] = await sql`select count(*)::int as c from delivery_ledger where announcement_id = ${a.id}`;
    expect(c).toBe(2); // unchanged (discord:mainnet-updates + telegram:main; no subscriptions in this test)
  });
});
