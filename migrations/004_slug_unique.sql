-- Revisions of the SAME announcement share a slug, so a plain unique index on slug is wrong.
-- Every announcement has exactly one revision-1 row, so uniqueness across announcements is
-- equivalent to uniqueness of revision-1 slugs. Revisions >1 are untouched.

-- First, de-duplicate any pre-existing revision-1 slug collisions so the unique index can
-- build on a database that already has them (e.g. a dev DB seeded before this constraint,
-- or a restore). The earliest-created row keeps the canonical slug; later collisions get
-- -2, -3, … appended. Only revision-1 rows are touched, so a legitimate revision-2 row
-- sharing its own announcement's slug is left alone. No-op on a clean database.
with ranked as (
  select id, slug,
         row_number() over (partition by slug order by created_at, id) as rn
  from announcements
  where revision = 1
)
update announcements a
  set slug = a.slug || '-' || r.rn
  from ranked r
  where a.id = r.id and a.revision = 1 and r.rn > 1;

create unique index if not exists announcements_slug_rev1 on announcements (slug) where revision = 1;
