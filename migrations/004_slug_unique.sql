-- Revisions of the SAME announcement share a slug, so a plain unique index on slug is wrong.
-- Every announcement has exactly one revision-1 row, so uniqueness across announcements is
-- equivalent to uniqueness of revision-1 slugs. Revisions >1 are untouched.
create unique index announcements_slug_rev1 on announcements (slug) where revision = 1;
