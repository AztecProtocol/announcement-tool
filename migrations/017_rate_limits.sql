-- Fixed-window counters for the two public write paths. Serverless instances
-- share nothing in memory, so the counter lives here. Rows are tiny and
-- short-lived; consumeRateLimit deletes windows older than a day.
create table rate_limits (
  key          text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (key, window_start)
);

-- `announce_app` (migration 014) is the least-privilege application role. The
-- rate limiter inserts, upserts and prunes its own rows, so it needs all four.
grant select, insert, update, delete on rate_limits to announce_app;
