-- Whether this announcement should apply the Discord channel's role-mention
-- prefix. Null means "not specified" and is treated as false by the adapter:
-- an announcement authored before this column existed must not start pinging.
alter table announcements add column if not exists mention_roles boolean;
