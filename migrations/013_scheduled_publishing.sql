-- Scheduled publishing: a future send time, and the status an announcement
-- waits in. Four-eyes is satisfied BEFORE the wait — two publishers approve at
-- scheduling time — so the worker only moves an already-approved announcement
-- from 'scheduled' to 'published'. It never approves anything itself.
alter table announcements add column if not exists scheduled_for timestamptz;

alter table announcements drop constraint if exists announcements_status_check;
alter table announcements add constraint announcements_status_check
  check (status in ('draft','publish_requested','scheduled','published','superseded','discarded'));

-- The worker polls for due rows every 15 seconds. This index keeps that poll
-- from scanning the whole table as the archive grows.
create index if not exists announcements_due_scheduled_idx
  on announcements (scheduled_for)
  where status = 'scheduled';
