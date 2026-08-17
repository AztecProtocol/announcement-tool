-- A rejected publication returns to draft, so status alone cannot record that a
-- review happened. These columns keep the last rejection visible on the draft:
-- who objected and why, so the author sees the objection when they reopen it.
alter table announcements add column if not exists publish_rejected_by text;
alter table announcements add column if not exists publish_rejected_reason text;
