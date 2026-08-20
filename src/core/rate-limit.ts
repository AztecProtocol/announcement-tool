/**
 * Fixed-window rate limiter, in-memory, per-process.
 *
 * PER-PROCESS ONLY. Counters live in a single `Map` inside this process's
 * memory. A deployment running more than one web process (multiple
 * instances behind a load balancer, a rolling deploy with overlap, etc.)
 * gets an independent limit per instance, not a shared one — an attacker
 * spread across instances effectively gets `limit * instanceCount`. This is
 * a deliberate simplification for a tool that today runs a single web
 * process; a future multi-instance deployment needs a shared store (e.g.
 * Redis) instead of this module. Do not assume this is airtight.
 *
 * `now` is injectable so callers (and tests) never need to sleep or use
 * real timers.
 */

export interface RateLimiter {
  /** Returns true if `key` is still within its limit for the current window, false if refused. */
  check(key: string): boolean;
  /** Number of keys currently tracked (post-eviction). Exposed so callers/tests can confirm the map does not grow without bound. */
  size(): number;
}

interface Entry {
  count: number;
  windowStart: number;
}

export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const { limit, windowMs } = opts;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  function evictExpired(current: number): void {
    for (const [key, entry] of entries) {
      if (current - entry.windowStart >= windowMs) entries.delete(key);
    }
  }

  return {
    check(key: string): boolean {
      const current = now();
      // Sweep expired entries on every call rather than on a timer — keeps
      // this module free of background timers (which would complicate
      // tests and shutdown) at the cost of a linear scan per call. Fine at
      // the low request volumes these two actions see.
      evictExpired(current);

      const existing = entries.get(key);
      if (!existing || current - existing.windowStart >= windowMs) {
        entries.set(key, { count: 1, windowStart: current });
        return true;
      }

      if (existing.count >= limit) return false;
      existing.count += 1;
      return true;
    },
    size(): number {
      return entries.size;
    },
  };
}
