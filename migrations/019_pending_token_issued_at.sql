-- pending_token is the filter-change confirmation token. Its sibling
-- verify_token gained an issued-at column and a 72-hour window in migration
-- 016; this one was left out, so an unconsumed change link stayed valid
-- forever. The token is already single-use (subscribe-flow.ts clears it on
-- success), so this closes the lifetime half of the same property.
--
-- No grant needed: announce_app already holds select/insert/update/delete on
-- subscriptions (migrations/014_app_role.sql).
-- Backfill uses now(), not created_at like migration 016. pending_token is
-- minted on an update to an existing row, so no column records when it was
-- issued. Using created_at would retroactively expire every live
-- filter-change link at deploy time. Cost: a stale, unconsumed link gets one
-- fresh 72-hour window at deploy.
alter table subscriptions add column pending_token_issued_at timestamptz;
update subscriptions set pending_token_issued_at = now() where pending_token is not null;
