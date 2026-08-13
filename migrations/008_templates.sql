create table templates (
  id         text primary key,
  name       text not null unique,
  input      jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);
