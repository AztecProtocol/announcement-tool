-- Publisher identity is an email address, and email addresses are compared
-- case-insensitively everywhere else in the world. Two casings of one
-- address in this table let one person satisfy four-eyes alone: request as
-- one casing, confirm as the other. Collapse existing rows to lowercase
-- (keeping the earliest, breaking ties deterministically), then refuse any
-- future row that is not lowercase.
--
-- The tie-break matters: `added_at` defaults to now(), which is the
-- *transaction* start time in Postgres, so three casings of one address
-- inserted in a single seeding transaction get an IDENTICAL added_at. Ordering
-- on added_at alone then keeps every row (nothing looks earlier than anything
-- else), the delete removes nothing, and the following lowercase update hits
-- the primary key twice and aborts. Comparing (added_at, ctid) keeps
-- "earliest wins" as the real tie-break while guaranteeing a strict order
-- between any two distinct rows, ctid included, so a survivor always exists.
delete from publishers p
  using publishers q
  where lower(p.email) = lower(q.email)
    and p.email <> q.email
    and (p.added_at, p.ctid) > (q.added_at, q.ctid);
update publishers set email = lower(email) where email <> lower(email);
alter table publishers add constraint publishers_email_lowercase check (email = lower(email));
