create table publishers (
  email    text primary key,
  added_at timestamptz not null default now()
);
