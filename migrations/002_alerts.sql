create table alert_state (
  key           text primary key,
  first_seen_at timestamptz not null default now(),
  notified_at   timestamptz
);
