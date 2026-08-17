-- Which Discord roles this announcement notifies. Null means "not specified":
-- an announcement authored before this column, or one targeting a destination
-- with a legacy prefix and no named roles, keeps the previous behaviour.
alter table announcements add column if not exists mention_role_ids text[];
