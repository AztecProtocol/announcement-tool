-- Widen the status check so a draft can be discarded. A discarded announcement
-- is hidden from every view but its row and its audit trail remain: the tables
-- are the audit source of truth and never delete rows.
alter table announcements drop constraint if exists announcements_status_check;
alter table announcements add constraint announcements_status_check
  check (status in ('draft','publish_requested','published','superseded','discarded'));
