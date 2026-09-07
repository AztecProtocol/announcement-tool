-- Email addresses are compared case-insensitively everywhere else in the
-- world, and the public subscribe action now lowercases before it looks a
-- subscriber up. Rows created before that change may still hold mixed case,
-- and the lookups in src/core/subscribe-flow.ts compare `endpoint` exactly.
-- A returning subscriber whose row reads `Alice@Example.com` would therefore
-- miss it, get a SECOND row, and receive every announcement twice. Collapse
-- the existing duplicates, lowercase what is left, then refuse any future
-- mixed-case email row.
--
-- Webhook rows are untouched: a URL path is case-sensitive, so lowercasing a
-- webhook endpoint would break delivery. Every statement below is therefore
-- scoped to `channel = 'email'`, and the constraint exempts other channels.
--
-- Survivor rule. A verified row is a person who proved ownership of the
-- address, so it outlives the unverified duplicates whatever the insertion
-- order — losing it would silently downgrade a confirmed subscriber back to
-- pending. `verified` is a boolean and false < true in Postgres, so
-- `s.verified < t.verified` deletes exactly the unverified rows when any
-- sibling is verified. When the verified flags are equal — none verified, or
-- (a state the unique index should already prevent, but which a restored dump
-- could still contain) more than one — the tie-break falls to earliest-wins.
--
-- The (created_at, ctid) pair, not created_at alone: `default now()` is the
-- *transaction* start time in Postgres, so several casings of one address
-- inserted by a single seeding transaction share an IDENTICAL created_at.
-- Ordering on created_at alone then keeps every row (nothing looks earlier
-- than anything else), the delete removes nothing, and the following
-- lowercase update hits `unique (channel, endpoint)` twice and aborts. Adding
-- ctid keeps "earliest wins" as the real tie-break while guaranteeing a
-- strict order between any two distinct rows, so a survivor always exists.
--
-- Re-running is a no-op. The migration runner records applied files and will
-- not replay this one, but the statements are written so that a second run on
-- an already-lowercase table changes nothing regardless: the delete finds no
-- pair differing only by case, and the update's `endpoint <> lower(endpoint)`
-- guard matches no row.
delete from subscriptions s
  using subscriptions t
  where s.channel = 'email' and t.channel = 'email'
    and lower(s.endpoint) = lower(t.endpoint)
    and s.endpoint <> t.endpoint
    and (
      s.verified < t.verified
      or (s.verified = t.verified and (s.created_at, s.ctid) > (t.created_at, t.ctid))
    );

update subscriptions set endpoint = lower(endpoint)
  where channel = 'email' and endpoint <> lower(endpoint);

alter table subscriptions add constraint email_endpoint_lowercase
  check (channel <> 'email' or endpoint = lower(endpoint));

-- No grant statement is needed. `announce_app` (migration 014) already holds
-- select, insert, update and delete on `subscriptions`, and a check
-- constraint needs no privilege of its own.
