alter table subscriptions add column pending_filters jsonb;
alter table subscriptions add column pending_token text unique;
