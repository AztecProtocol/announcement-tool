import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import {
  createDraft, requestPublish, confirmPublish, withdrawPublish, rejectPublish,
} from '../src/core/announcements.js';
import { listAwaitingConfirmation } from '../src/core/queries.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const critical = (title: string): AnnouncementInput => ({
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title, bodyMd: 'Body.', actionsRequired: [],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v1' }],
});

async function requested(title: string) {
  const a = await createDraft(sql, critical(title), 'alice@test.local');
  await requestPublish(sql, a.id, 'alice@test.local');
  return a;
}

describe('withdrawPublish', () => {
  it('returns the announcement to draft', async () => {
    const a = await requested('Withdraw me');
    const out = await withdrawPublish(sql, a.id, 'alice@test.local');
    expect(out.status).toBe('draft');
  });

  it('clears the requester so a fresh request is needed', async () => {
    const a = await requested('Withdraw me');
    const out = await withdrawPublish(sql, a.id, 'alice@test.local');
    expect(out.publishRequestedBy).toBeUndefined();
  });

  it('removes it from the pending queue', async () => {
    const a = await requested('Withdraw me');
    await withdrawPublish(sql, a.id, 'alice@test.local');
    const rows = await listAwaitingConfirmation(sql);
    expect(rows.map(r => r.id)).not.toContain(a.id);
  });

  it('refuses a publisher who is not the requester', async () => {
    const a = await requested('Not yours');
    await expect(withdrawPublish(sql, a.id, 'bob@test.local')).rejects.toThrow();
  });

  it('refuses when the announcement is not awaiting confirmation', async () => {
    const a = await createDraft(sql, critical('Just a draft'), 'alice@test.local');
    await expect(withdrawPublish(sql, a.id, 'alice@test.local')).rejects.toThrow();
  });

  it('writes an audit row', async () => {
    const a = await requested('Audit me');
    await withdrawPublish(sql, a.id, 'alice@test.local');
    const rows = await sql`select * from audit_log where target = ${a.id} and action = 'publish_withdrawn'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('alice@test.local');
  });

  it('allows a fresh request afterwards', async () => {
    const a = await requested('Round two');
    await withdrawPublish(sql, a.id, 'alice@test.local');
    const out = await requestPublish(sql, a.id, 'alice@test.local');
    expect(out.status).toBe('publish_requested');
  });

  it('clears a stale rejection banner when withdrawing a later re-request', async () => {
    const a = await requested('Rejected, re-requested, then withdrawn');
    await rejectPublish(sql, a.id, 'bob@test.local', 'wrong version number');
    await requestPublish(sql, a.id, 'alice@test.local');
    const out = await withdrawPublish(sql, a.id, 'alice@test.local');
    expect(out.publishRejectedBy).toBeUndefined();
    expect(out.publishRejectedReason).toBeUndefined();
  });
});

describe('rejectPublish', () => {
  it('returns the announcement to draft and records the reason', async () => {
    const a = await requested('Reject me');
    const out = await rejectPublish(sql, a.id, 'bob@test.local', 'Wrong version number');
    expect(out.status).toBe('draft');
    expect(out.publishRejectedBy).toBe('bob@test.local');
    expect(out.publishRejectedReason).toBe('Wrong version number');
  });

  it('refuses the requester — rejecting your own request is withdrawal', async () => {
    const a = await requested('Self reject');
    await expect(rejectPublish(sql, a.id, 'alice@test.local', 'changed my mind')).rejects.toThrow();
  });

  it('requires a reason', async () => {
    const a = await requested('No reason');
    await expect(rejectPublish(sql, a.id, 'bob@test.local', '   ')).rejects.toThrow();
  });

  it('writes an audit row carrying the reason', async () => {
    const a = await requested('Audit the reason');
    await rejectPublish(sql, a.id, 'bob@test.local', 'Deadline is in the past');
    const rows = await sql`select * from audit_log where target = ${a.id} and action = 'publish_rejected'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('bob@test.local');
    expect((rows[0].detail as { reason?: string }).reason).toBe('Deadline is in the past');
  });

  it('does not allow a rejected announcement to be confirmed', async () => {
    const a = await requested('Rejected then confirmed');
    await rejectPublish(sql, a.id, 'bob@test.local', 'No');
    await expect(confirmPublish(sql, a.id, 'bob@test.local')).rejects.toThrow();
  });
});
