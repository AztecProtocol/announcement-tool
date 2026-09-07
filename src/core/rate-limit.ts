import type { Sql } from 'postgres';

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Limits for the two public, unauthenticated write paths. Both are per fixed
 * clock window (not a sliding window), so a caller who exhausts a window waits
 * only until that window ends.
 *
 * The abuse being bounded: subscribeEmail sends a confirmation email to any
 * address given, so an unthrottled endpoint is an email bomber pointed at a
 * third party. The per-address limit stops one victim being mailed repeatedly;
 * the per-IP limit stops one source walking through many addresses.
 */
export const RATE_LIMITS = {
  emailPerAddress: { limit: 3, windowSeconds: 3600 },
  emailPerIp: { limit: 10, windowSeconds: 3600 },
  webhookPerIp: { limit: 5, windowSeconds: 3600 },
} satisfies Record<string, RateLimitRule>;

/** Rows in windows older than this are pruned opportunistically on every call. */
const PRUNE_AGE_MS = 86_400_000;

/**
 * Consume one unit against `key` and report whether the caller may proceed.
 *
 * Serverless instances share nothing in memory, so the counter is a database
 * row keyed by (key, window_start). The insert-on-conflict-increment is a
 * single statement, so concurrent requests cannot both read a stale count.
 *
 * `key` MUST be prefixed by its caller (`email:addr:`, `email:ip:`,
 * `webhook:ip:`) so that raw user input from one path can never collide with
 * a counter belonging to another.
 */
export async function consumeRateLimit(
  sql: Sql,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowMs = rule.windowSeconds * 1000;
  const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);

  const [row] = await sql<Array<{ count: number }>>`
    insert into rate_limits (key, window_start, count)
    values (${key}, ${windowStart}, 1)
    on conflict (key, window_start) do update set count = rate_limits.count + 1
    returning count
  `;

  const count = Number(row.count);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - now.getTime()) / 1000));

  // Housekeeping. Cheap (the table is small and the predicate hits the primary
  // key's window_start ordering), and it keeps the table from growing without
  // needing a separate cron job.
  await sql`delete from rate_limits where window_start < ${new Date(now.getTime() - PRUNE_AGE_MS)}`;

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds,
  };
}
