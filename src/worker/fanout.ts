import type { Sql } from 'postgres';
import type { ChannelAdapter } from '../adapters/types.js';
import { rowToAnnouncement } from '../core/announcements.js';
import type { DeliveryKind } from '../core/types.js';

export const BACKOFF_MINUTES = [2, 5, 10, 20, 30];
export const MAX_ATTEMPTS = 5;

/**
 * Drain due outbox rows once. Volume is a few messages a month, single worker:
 * holding the row lock (FOR UPDATE SKIP LOCKED) across the adapter call is a
 * deliberate simplification — crash-safety stays trivial, a concurrent worker
 * skips locked rows, and adapter timeouts bound the lock time.
 */
export async function runFanoutOnce(
  sql: Sql, adapters: Record<string, ChannelAdapter>, batch = 20,
): Promise<{ delivered: number; failed: number }> {
  let delivered = 0, failed = 0;
  const known = Object.keys(adapters);
  if (known.length === 0) return { delivered, failed };

  await sql.begin(async tx => {
    const due = await tx`select * from delivery_ledger
      where status in ('pending','failed') and next_attempt_at <= now() and channel in ${tx(known)}
      order by next_attempt_at
      limit ${batch}
      for update skip locked`;

    for (const row of due) {
      const annRows = await tx`select * from announcements
        where id = ${row.announcement_id} and revision = ${row.revision}`;
      if (!annRows[0]) {
        // Poison row: the announcement was deleted out from under this ledger entry.
        // Mark it exhausted (not delivered) so it stops heading every future batch —
        // without this it throws below and stalls the whole pipeline forever.
        // next_attempt_at is stamped here for the same reason as the catch branch below:
        // health.ts's exhausted-window compares against it.
        await tx`update delivery_ledger
          set status = 'exhausted', last_error = ${'announcement missing'}, next_attempt_at = now()
          where announcement_id = ${row.announcement_id} and revision = ${row.revision}
            and kind = ${row.kind} and channel = ${row.channel} and target = ${row.target}`;
        continue;
      }
      const a = rowToAnnouncement(annRows[0]);
      const attempts = (row.attempts as number) + 1;
      try {
        await adapters[row.channel as string].deliver(a, row.target as string, row.kind as DeliveryKind);
        await tx`update delivery_ledger set status = 'delivered', attempts = ${attempts}, delivered_at = now()
          where announcement_id = ${row.announcement_id} and revision = ${row.revision}
            and kind = ${row.kind} and channel = ${row.channel} and target = ${row.target}`;
        delivered++;
      } catch (err) {
        const exhausted = attempts >= MAX_ATTEMPTS;
        const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
        // health.ts's exhausted-window relies on next_attempt_at being written here on
        // exhaustion and then staying frozen (nothing updates it again after this row exhausts).
        await tx`update delivery_ledger
          set status = ${exhausted ? 'exhausted' : 'failed'}, attempts = ${attempts},
              last_error = ${String(err).slice(0, 500)},
              next_attempt_at = now() + make_interval(mins => ${backoff})
          where announcement_id = ${row.announcement_id} and revision = ${row.revision}
            and kind = ${row.kind} and channel = ${row.channel} and target = ${row.target}`;
        failed++;
      }
    }
  });
  return { delivered, failed };
}
