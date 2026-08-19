import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import {
  createDraft, confirmPublish, requestPublish, withdrawPublish, rejectPublish,
  schedulePublish, confirmSchedule, cancelSchedule, FourEyesError,
} from '../src/core/announcements.js';
import type { AnnouncementInput } from '../src/core/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const draftInput = (over: Partial<AnnouncementInput> = {}): AnnouncementInput => ({
  type: 'upgrade', networks: ['mainnet'], audiences: ['operators'], severity: 'critical',
  title: 'Scheduled announcement', bodyMd: 'Body.', actionsRequired: [],
  links: [{ label: 'GitHub release', url: 'https://github.com/AztecProtocol/aztec-packages/releases/tag/v1' }],
  ...over,
});

const FUTURE = '2030-01-01T00:00:00.000Z';

describe('schedulePublish', () => {
  it('sends a non-critical announcement straight to scheduled', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'info' }), 'author@example.com');
    const s = await schedulePublish(sql, a.id, FUTURE, 'author@example.com');
    expect(s.status).toBe('scheduled');
    expect(s.scheduledFor).toBe(FUTURE);
  });

  it('holds a critical announcement at publish_requested until a second publisher confirms', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'critical' }), 'one@example.com');
    const req = await schedulePublish(sql, a.id, FUTURE, 'one@example.com');
    expect(req.status).toBe('publish_requested');
    expect(req.scheduledFor).toBe(FUTURE);

    const ok = await confirmSchedule(sql, a.id, 'two@example.com');
    expect(ok.status).toBe('scheduled');
    expect(ok.scheduledFor).toBe(FUTURE);
  });

  it('refuses to let the requester confirm their own schedule', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'critical' }), 'one@example.com');
    await schedulePublish(sql, a.id, FUTURE, 'one@example.com');
    await expect(confirmSchedule(sql, a.id, 'one@example.com')).rejects.toThrow(FourEyesError);
  });

  it('refuses a time in the past', async () => {
    const a = await createDraft(sql, draftInput(), 'author@example.com');
    await expect(schedulePublish(sql, a.id, '2020-01-01T00:00:00.000Z', 'author@example.com'))
      .rejects.toThrow(/past/i);
  });

  it('refuses a malformed time', async () => {
    const a = await createDraft(sql, draftInput(), 'author@example.com');
    await expect(schedulePublish(sql, a.id, 'not-a-date', 'author@example.com'))
      .rejects.toThrow();
  });

  it('refuses to schedule anything that is not a draft', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'info' }), 'author@example.com');
    await schedulePublish(sql, a.id, FUTURE, 'author@example.com');
    await expect(schedulePublish(sql, a.id, FUTURE, 'author@example.com')).rejects.toThrow(/draft/i);
  });
});

describe('cancelSchedule', () => {
  it('returns a scheduled announcement to draft and clears the schedule', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'info' }), 'author@example.com');
    await schedulePublish(sql, a.id, FUTURE, 'author@example.com');
    const c = await cancelSchedule(sql, a.id, 'other@example.com');
    expect(c.status).toBe('draft');
    expect(c.scheduledFor).toBeUndefined();
  });

  it('clears the requester and confirmer so re-scheduling needs a fresh second confirmation', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'critical' }), 'one@example.com');
    await schedulePublish(sql, a.id, FUTURE, 'one@example.com');
    await confirmSchedule(sql, a.id, 'two@example.com');
    const cancelled = await cancelSchedule(sql, a.id, 'two@example.com');
    expect(cancelled.publishConfirmedBy).toBeUndefined();

    // Re-scheduling starts over: it must land in publish_requested again, not scheduled.
    const again = await schedulePublish(sql, a.id, FUTURE, 'one@example.com');
    expect(again.status).toBe('publish_requested');
    expect(again.publishRequestedBy).toBe('one@example.com');
    expect(again.publishConfirmedBy).toBeUndefined();
  });

  it('refuses to cancel something that is not scheduled', async () => {
    const a = await createDraft(sql, draftInput(), 'author@example.com');
    await expect(cancelSchedule(sql, a.id, 'author@example.com')).rejects.toThrow(/scheduled/i);
  });
});

describe('confirmPublish on a scheduled request', () => {
  it('refuses, so a schedule cannot be turned into an immediate send', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'critical' }), 'one@example.com');
    await schedulePublish(sql, a.id, FUTURE, 'one@example.com');
    await expect(confirmPublish(sql, a.id, 'two@example.com')).rejects.toThrow(/schedul/i);
  });
});

describe('a stale scheduled_for must not survive the pre-existing exits to draft', () => {
  it('withdrawing a scheduled critical request clears the schedule and leaves it publishable again', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'critical' }), 'one@example.com');
    await schedulePublish(sql, a.id, FUTURE, 'one@example.com');
    const withdrawn = await withdrawPublish(sql, a.id, 'one@example.com');
    expect(withdrawn.status).toBe('draft');
    expect(withdrawn.scheduledFor).toBeUndefined();

    // The property that matters: the row is publishable again through the normal path.
    await requestPublish(sql, a.id, 'one@example.com');
    const published = await confirmPublish(sql, a.id, 'two@example.com');
    expect(published.status).toBe('published');
  });

  it('rejecting a scheduled critical request clears the schedule and leaves it publishable again', async () => {
    const a = await createDraft(sql, draftInput({ severity: 'critical' }), 'one@example.com');
    await schedulePublish(sql, a.id, FUTURE, 'one@example.com');
    const rejected = await rejectPublish(sql, a.id, 'two@example.com', 'not ready yet');
    expect(rejected.status).toBe('draft');
    expect(rejected.scheduledFor).toBeUndefined();

    // The property that matters: the row is publishable again through the normal path.
    await requestPublish(sql, a.id, 'one@example.com');
    const published = await confirmPublish(sql, a.id, 'two@example.com');
    expect(published.status).toBe('published');
  });
});
