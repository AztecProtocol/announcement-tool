-- Least-privilege application role.
--
-- Today the app connects as `announce`, which OWNS every table and can
-- DROP/TRUNCATE/ALTER/DELETE anything, including the two append-only audit
-- tables. On the split deployment, Postgres's port is exposed to the public
-- internet (no tailnet in front of it), so a leaked application credential
-- is now a realistic threat, not a hypothetical one. This migration creates
-- a separate `announce_app` role scoped to exactly what the application code
-- does, so that credential — if it leaks — cannot destroy the audit record,
-- drop a table, or grant itself new rights.
--
-- WHAT THE APP ACTUALLY DOES (verified by grep, not assumed):
--   grep -rn "delete from" --include=*.ts src/ app/ scripts/
--     src/core/templates.ts:46      delete from templates where id = ...
--     src/core/tokens-flow.ts:8     delete from subscriptions where id = ...
--     scripts/reset-test-data.ts    delete from delivery_ledger, alert_state,
--                                    announcements, audit_log, channel_settings,
--                                    subscriptions
--   grep -rniE "truncate|drop table|alter table|sql.unsafe" --include=*.ts src/ app/ scripts/
--     test/helpers.ts truncates everything, but that is the test suite
--     running against the local dev database, not application code, and
--     needs no production grant. Nothing in src/ or app/ drops, truncates,
--     or alters, and nothing uses sql.unsafe with untrusted input.
--
-- CONCLUSION: the application needs DELETE on `templates` (template removal)
-- and `subscriptions` (unsubscribe removes the row, not a status flag) —
-- nothing else.
--
-- `scripts/reset-test-data.ts` is a LOCAL TEST-DATA RESET TOOL. It deletes
-- from delivery_ledger and audit_log too, but that is not evidence the
-- production app role needs those rights — it is evidence this script is a
-- developer tool that should run as the `announce` owner against a local
-- dev database, same as `test/helpers.ts`'s truncate. `delivery_ledger` and
-- `audit_log` are append-only audit records: delivery_ledger is the record
-- of what was actually sent to whom, and audit_log is the record of who did
-- what. The entire point of this migration is that a compromised app
-- credential cannot erase either one. Do NOT widen this grant to add DELETE
-- on delivery_ledger or audit_log because reset-test-data.ts (or some other
-- future dev/ops script) wants it — give that script its own connection as
-- the `announce` owner instead.
--
-- No DROP, TRUNCATE, or ALTER is granted on anything, ever, for this role.
--
-- NO PASSWORD LITERAL IN THIS FILE. The role is created with a placeholder
-- password, and the deployment process must rotate it immediately after
-- this migration runs, e.g.:
--   psql "$DATABASE_URL" -c "alter role announce_app with password '$(openssl rand -base64 32)';"
-- using a superuser/owner connection, with the generated password stored
-- only in the deployment's secret manager / env, never committed. Rotating
-- immediately after creation (rather than leaving the placeholder live)
-- means the placeholder itself is never a usable credential in any
-- environment that has run this migration and then rotated as documented.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'announce_app') then
    create role announce_app with login password 'CHANGE_ME_PLACEHOLDER_ROTATE_IMMEDIATELY';
  end if;
end
$$;

grant connect on database announce to announce_app;
grant usage on schema public to announce_app;

-- Full read/write on the operational tables the app writes through its
-- normal publish/subscribe/delivery flows.
grant select, insert, update on
  announcements,
  channel_settings,
  publishers
to announce_app;

-- delivery_ledger: the worker inserts and updates delivery attempts
-- (status, attempts, next_attempt_at, last_error, delivered_at) but must
-- never be able to delete a row — see the comment block above.
grant select, insert, update on delivery_ledger to announce_app;

-- audit_log: append-only by design. INSERT and SELECT only — no UPDATE
-- (an audit row, once written, must not change) and no DELETE.
grant select, insert on audit_log to announce_app;

-- alert_state: health-alerting bookkeeping, read/write only.
grant select, insert, update on alert_state to announce_app;

-- templates and subscriptions: the only two tables the application code
-- actually deletes from (src/core/templates.ts, src/core/tokens-flow.ts).
grant select, insert, update, delete on templates to announce_app;
grant select, insert, update, delete on subscriptions to announce_app;

-- Sequences: audit_log.seq (bigserial) is the only auto-incrementing
-- column in the schema (checked: grep -rniE "serial|bigserial|identity"
-- migrations/*.sql). INSERT into audit_log needs USAGE on its sequence.
grant usage on sequence audit_log_seq_seq to announce_app;

-- schema_migrations: the app itself never touches this table (only
-- src/db/migrate.ts does, running as the owner during deploy), so no grant
-- is given here. If that ever changes, add the grant explicitly then.

-- FUTURE TABLES: deliberately NOT using `alter default privileges` here.
-- Default privileges would make every *future* table automatically
-- readable/writable by announce_app the moment it's created by whichever
-- role runs migrations — silently widening this role's access with no
-- review, which is exactly the kind of drift this task exists to prevent.
-- A new table's sensitivity (is it another append-only audit table? does it
-- hold secrets like channel_settings does?) can't be known in advance, so
-- each future migration that adds a table must add its own explicit grant
-- for announce_app (or deliberately omit one, e.g. for another audit
-- table), the same way this file does. That grant is one line and keeps
-- the decision visible in the migration that introduces the table, instead
-- of being made once here for tables that don't exist yet. If a later
-- migration adds a table and forgets the grant, the app fails closed
-- (permission denied) rather than failing open — the correct default for a
-- credential that is now reachable from the public internet.
