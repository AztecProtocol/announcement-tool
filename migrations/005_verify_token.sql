alter table subscriptions add column verify_token text unique;
update subscriptions
  set verify_token = md5(random()::text || clock_timestamp()::text)
  where verify_token is null;
