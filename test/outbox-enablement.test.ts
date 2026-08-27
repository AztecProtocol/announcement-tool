import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { resetEnabledChannelsCache } from '../src/core/enabled-channels.js';
import { createDraft } from '../src/core/announcements.js';
import { createSubscription, verifySubscription } from '../src/core/subscriptions.js';
import { countFanoutTargets } from '../src/core/outbox.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => {
  await resetDb(sql);
  await sql`insert into channel_settings (key, channel, config) values
    ('signal:mainnet-updates', 'signal', '{"networks":["mainnet"],"types":["upgrade","info"],"phone_number":"+10000000000"}')`;
});
afterEach(() => {
  delete process.env.ENABLED_CHANNELS;
  resetEnabledChannelsCache();
});
afterAll(async () => { await sql.end(); });

const critical: AnnouncementInput = {
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Upgrade to v5.1.0', bodyMd: 'Do it.', actionsRequired: [],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v5.1.0' }],
};

describe('countFanoutTargets channel enablement', () => {
  it('includes a broadcast channel when it is enabled', async () => {
    process.env.ENABLED_CHANNELS = 'signal';
    resetEnabledChannelsCache();
    const a = await createDraft(sql, critical, 'alice@x');
    const targets = await countFanoutTargets(sql, a);
    expect(targets.some(t => t.channel === 'signal')).toBe(true);
  });

  it('omits a broadcast channel when it is disabled', async () => {
    process.env.ENABLED_CHANNELS = 'discord';
    resetEnabledChannelsCache();
    const a = await createDraft(sql, critical, 'alice@x');
    const targets = await countFanoutTargets(sql, a);
    expect(targets.some(t => t.channel === 'signal')).toBe(false);
  });

  it('omits a disabled SUBSCRIPTION channel too, not just broadcast ones', async () => {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: 'x@y.z', filters: { severities: ['critical'] } });
    await verifySubscription(sql, sub.id);

    process.env.ENABLED_CHANNELS = 'discord';
    resetEnabledChannelsCache();
    const a = await createDraft(sql, critical, 'alice@x');
    const targets = await countFanoutTargets(sql, a);
    expect(targets.some(t => t.channel === 'email')).toBe(false);
  });
});
