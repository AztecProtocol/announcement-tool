-- Confirmation tokens (verify_token) never expired and were never cleared
-- after use, so a leaked or logged confirmation link stayed valid forever
-- and could be replayed. Add an issued-at timestamp so lookups can enforce
-- a 72-hour window, and clear both columns on successful confirmation so a
-- used token can never be replayed either.
--
-- announce_app already has update on subscriptions (granted by an earlier
-- migration), so no new grant is needed here.
alter table subscriptions add column verify_token_issued_at timestamptz;
update subscriptions set verify_token_issued_at = created_at where verify_token is not null;
