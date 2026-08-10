-- Repairs rows written before the double-encoding bug fix in src/core/announcements.ts.
-- Prior code passed JSON.stringify(...) into a jsonb column, and the postgres driver
-- serialized that string again, so the column held a JSON *string* instead of an
-- array/object. This unwraps one layer of encoding for any row still affected.
-- Idempotent: only rewrites rows where jsonb_typeof reports 'string'.

update announcements
set actions_required = (actions_required #>> '{}')::jsonb
where jsonb_typeof(actions_required) = 'string';

update announcements
set links = (links #>> '{}')::jsonb
where jsonb_typeof(links) = 'string';

update audit_log
set detail = (detail #>> '{}')::jsonb
where detail is not null and jsonb_typeof(detail) = 'string';
