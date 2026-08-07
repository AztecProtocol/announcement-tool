create table announcements (
  id                   text not null,
  revision             int  not null,
  slug                 text not null,
  type                 text not null check (type in ('upgrade','governance','info')),
  networks             text[] not null,
  audiences            text[] not null,
  severity             text not null check (severity in ('critical','recommended','info')),
  title                text not null,
  body_md              text not null,
  actions_required     jsonb not null default '[]',
  links                jsonb not null default '[]',
  status               text not null check (status in ('draft','publish_requested','published','superseded')),
  supersedes           text,
  expires_at           timestamptz,
  created_by           text not null,
  publish_requested_by text,
  publish_confirmed_by text,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  primary key (id, revision)
);
create index announcements_slug on announcements (slug);

create table subscriptions (
  id                 text primary key,
  channel            text not null check (channel in ('email','webhook')),
  endpoint           text not null,
  verified           boolean not null default false,
  secret             text,
  filter_networks    text[] not null default '{mainnet,testnet}',
  filter_types       text[] not null default '{upgrade,governance,info}',
  filter_severities  text[] not null default '{critical,recommended,info}',
  filter_audiences   text[] not null default '{operators}',
  unsubscribe_token  text not null unique,
  created_at         timestamptz not null default now(),
  unique (channel, endpoint)
);

create table delivery_ledger (
  announcement_id text not null,
  revision        int  not null,
  kind            text not null default 'publish' check (kind in ('publish','update','reminder')),
  channel         text not null check (channel in ('discord','telegram','signal','email','webhook')),
  target          text not null,
  status          text not null default 'pending' check (status in ('pending','delivered','failed','exhausted')),
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  delivered_at    timestamptz,
  primary key (announcement_id, revision, kind, channel, target)
);
create index delivery_due on delivery_ledger (next_attempt_at) where status in ('pending','failed');

create table audit_log (
  seq    bigserial primary key,
  actor  text not null,
  action text not null,
  target text not null,
  detail jsonb,
  at     timestamptz not null default now()
);
-- Prod hardening (Plan 5): app connects as a role with INSERT-only on audit_log.
-- In dev the app user owns the tables, so the grant lives with the prod role setup.

create table channel_settings (
  key     text primary key,
  channel text not null check (channel in ('discord','telegram','signal')),
  config  jsonb not null
);
