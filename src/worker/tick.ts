import type { Sql } from 'postgres';
import { runFanoutOnce } from './fanout.js';
import { dispatchHealthAlerts } from '../core/alerts.js';
import { publishDueScheduled } from '../core/announcements.js';
import type { ChannelAdapter } from '../adapters/types.js';
import type { EmailSender } from '../adapters/esp.js';

export interface TickResult {
  /** Announcements the scheduler published this tick. Carries the slug as well as
   *  the id because that is what makes a worker log line readable to a human
   *  watching a scheduled send land. */
  published: { id: string; slug: string }[];
  delivered: number;
  failed: number;
  alerted: number;
}

/**
 * One pass of the worker's periodic tick: publish due scheduled announcements,
 * run the delivery fan-out, and dispatch health alerts. Shared by the always-on
 * worker (src/worker/main.ts) and the Netlify scheduled function, so there is
 * exactly one implementation of this behaviour — copying it would let the two
 * hosts drift apart.
 *
 * Does not throw for a per-section failure: it records and continues, matching
 * the worker's historical behaviour. Callers log the returned counts in their
 * own idiom.
 */
export async function runTick(
  sql: Sql,
  adapters: Record<string, ChannelAdapter>,
  sender: EmailSender,
): Promise<TickResult> {
  const published: { id: string; slug: string }[] = [];
  let delivered = 0;
  let failed = 0;
  let alerted = 0;

  // Scheduling gets its own try/catch: a failing scheduler must not skip
  // fan-out or health alerting on this tick — those are the mechanisms that
  // would tell an operator something is wrong, so they must keep running
  // even while the scheduler is broken.
  try {
    const due = await publishDueScheduled(sql);
    for (const a of due) published.push({ id: a.id, slug: a.slug });
  } catch (err) {
    console.error('scheduled publish error:', err);
  }
  try {
    const res = await runFanoutOnce(sql, adapters);
    delivered = res.delivered;
    failed = res.failed;
    const alerts = await dispatchHealthAlerts(sql, sender);
    alerted = alerts.length;
    for (const i of alerts) console.warn(`HEALTH ${i.kind} [${i.channel}] ${i.announcementId}: ${i.detail}`);
  } catch (err) {
    console.error('fanout tick error:', err);
  }

  return { published, delivered, failed, alerted };
}
