# Infra notes

## Database role: `announce_app`

`migrations/014_app_role.sql` creates a least-privilege Postgres role,
`announce_app`, for the application to connect as instead of the database
owner (`announce`). This matters once Postgres's port is reachable from the
public internet (the split deployment) and not only from a private network:
a leaked application credential must not be able to `DROP`/`TRUNCATE`/`ALTER`
anything, or `DELETE` from the two append-only audit tables
(`delivery_ledger`, `audit_log`).

**What it can do:** `SELECT`/`INSERT`/`UPDATE` on `announcements`,
`channel_settings`, `publishers`, `delivery_ledger`, `alert_state`;
`SELECT`/`INSERT` (no `UPDATE`, no `DELETE`) on `audit_log`; full
`SELECT`/`INSERT`/`UPDATE`/`DELETE` on `templates` and `subscriptions` — the
only two tables the application code deletes from
(`src/core/templates.ts`, `src/core/tokens-flow.ts`). See the comment block
at the top of `migrations/014_app_role.sql` for the full reasoning,
including why `delivery_ledger` and `audit_log` deliberately do **not** get
`DELETE` even though the local dev/test reset tooling
(`scripts/reset-test-data.ts`, `test/helpers.ts`) deletes/truncates them —
those are developer tools that run as the `announce` owner, not the app.

**No `DROP`, `TRUNCATE`, or `ALTER` is granted, ever.**

### Deploying: setting the real password

The migration creates the role with a placeholder password
(`CHANGE_ME_PLACEHOLDER_ROTATE_IMMEDIATELY`) because migrations are
committed to git and secrets must never enter git. After running the
migration against a real deployment, rotate the password immediately, as a
superuser / the `announce` owner:

```sh
psql "$DATABASE_URL" -c "alter role announce_app with password '$(openssl rand -base64 32)';"
```

Store the generated password only in the deployment's secret manager / env
(e.g. as the credential in the application's `DATABASE_URL`), never in git.
Point the application's `DATABASE_URL` at `announce_app`, not `announce`,
once the rotation is done — the app should never connect as the table
owner in a deployed environment. `src/db/migrate.ts` (run at deploy time,
separately from the running app) still connects as the owner, since it
needs `CREATE TABLE`/`ALTER TABLE` rights the app role does not have.

### Future tables

`014_app_role.sql` deliberately does **not** use
`alter default privileges` to auto-grant `announce_app` access to tables
created later. Each future migration that adds a table must add its own
explicit grant for `announce_app` in that same migration (or deliberately
omit one, e.g. for another append-only audit table) — see the comment in
`014_app_role.sql` for the reasoning. A forgotten grant fails closed
(`permission denied`), not open, which is the correct default for a
credential now reachable from the public internet.
