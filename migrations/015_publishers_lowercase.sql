-- Publisher identity is an email address, and email addresses are compared
-- case-insensitively everywhere else in the world. Two casings of one
-- address in this table let one person satisfy four-eyes alone: request as
-- one casing, confirm as the other. Collapse existing rows to lowercase
-- (keeping the earliest), then refuse any future row that is not lowercase.
delete from publishers p
  using publishers q
  where lower(p.email) = lower(q.email)
    and p.email <> q.email
    and p.added_at > q.added_at;
update publishers set email = lower(email) where email <> lower(email);
alter table publishers add constraint publishers_email_lowercase check (email = lower(email));
