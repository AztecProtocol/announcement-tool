# Infra notes

## Database role: `announce_app`

`migrations/014_app_role.sql` creates a least-privilege Postgres role,
`announce_app`, for the application to connect as instead of the database
owner (`announce`). This matters once Postgres's port is reachable from the
public internet (the split deployment) and not only from a private network:
a leaked application credential must not be able to `DROP`/`TRUNCATE`/`ALTER`
anything, or `DELETE` from the two append-only audit tables
(`delivery_ledger`, `audit_log`).

**What it can do:** `SELECT`/`INSERT`/`UPDATE` on `announcements`;
`SELECT`/`INSERT`/`UPDATE` on `delivery_ledger` and `alert_state`;
`SELECT`/`INSERT` (no `UPDATE`, no `DELETE`) on `audit_log`; full
`SELECT`/`INSERT`/`UPDATE`/`DELETE` on `templates` and `subscriptions` — the
only two tables the application code deletes from
(`src/core/templates.ts`, `src/core/tokens-flow.ts`); and **`SELECT` only**
on `channel_settings` and `publishers`. See the comment block at the top of
`migrations/014_app_role.sql` for the full reasoning, including:

- why `delivery_ledger` and `audit_log` deliberately do **not** get
  `DELETE` even though the local dev/test reset tooling
  (`scripts/reset-test-data.ts`, `test/helpers.ts`) deletes/truncates them —
  those are developer tools that run as the `announce` owner, not the app.
- why `channel_settings` and `publishers` are **read-only** for the app,
  even though an earlier version of this migration granted `INSERT`/
  `UPDATE` on both. Every app touch of either table is a read; the only
  writes anywhere are owner-run operator scripts
  (`scripts/setup-channel.ts`, `scripts/seed-publisher.ts`). `publishers`
  is the four-eyes identity list — `INSERT` there would let a leaked
  credential add itself (and a second identity) as publishers and approve
  its own critical announcement without touching either audit table.
  `channel_settings` holds the Discord webhook URL and Telegram bot
  token — `UPDATE` there would let a leaked credential silently redirect
  or break delivery.

**No `DROP`, `TRUNCATE`, or `ALTER` is granted, ever.**

### Deploying: setting the real password

The migration creates the role `NOLOGIN`, with no password at all — not
even a placeholder. A committed placeholder password would be a real,
working credential from the moment the migration runs, on a port reachable
from the public internet, until someone remembers to rotate it. `NOLOGIN`
fails closed instead: any connection attempt as `announce_app` before the
step below is a loud, immediate `FATAL: role "announce_app" is not
permitted to log in`, not a silent open door. After running the migration
against a real deployment, enable login with a real password, as a
superuser / the `announce` owner:

```sh
psql "$DATABASE_URL" -c "alter role announce_app with login password '$(openssl rand -base64 32)';"
```

Store the generated password only in the deployment's secret manager / env
(e.g. as the credential in the application's `DATABASE_URL`), never in git.
Point the application's `DATABASE_URL` at `announce_app`, not `announce`,
once this step is done — the app should never connect as the table owner
in a deployed environment. `src/db/migrate.ts` (run at deploy time,
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

## Deploying the split infrastructure — the runbook

This is the procedure for standing up `announce.aztec.network`: one Hetzner
VM (Postgres + the Signal sidecar + Caddy), with the app and worker running
on Netlify, not here. Follow the steps **in order** — several of them exist
specifically because running them out of order produces a failure that
looks like a different bug than the one it actually is (noted inline below).

For the Terraform-specific detail behind step 1 (required apply order,
`prevent_destroy`, state), see `terraform/README.md` — this section does
not repeat that detail, only the parts of the procedure that live outside
Terraform.

### 0. What this VM provisions, and what it deliberately does not

**Provisions:** Postgres (port 5432, publicly reachable — see the security
note below), `signal-cli-rest-api` (not published to the host directly),
and Caddy (port 443 — obtains/renews the Let's Encrypt certificate for
`announce.aztec.network` and reverse-proxies to the Signal sidecar behind a
shared-secret gate), plus a nightly backup job. See
`infra/docker-compose.split.yml`'s top comment and `infra/Caddyfile.split`
for exactly what runs and why.

**Does not provision:**
- **The app or the worker.** Those run on Netlify (`feat/netlify-deployment`).
  This VM has no `app`/`worker`/`migrate` service — `main`'s
  `docker-compose.prod.yml` is a different, single-VM deployment; do not
  confuse the two.
- **A registered Signal account.** `signal-cli-rest-api` comes up, but
  nothing registers a phone number with it. Signal is supported by this
  stack (the sidecar, the Caddy gate, `signal-receive`'s keep-alive job all
  exist) but is not usable until a number is registered by hand — see
  `main`'s README Signal registration notes for that procedure, which is
  unchanged by this branch. Do not add `signal` to Netlify's
  `ENABLED_CHANNELS` until that is done (see step 8).
- **DNS.** Terraform does not manage the `aztec.network` nameservers — the
  A record is a manual step (step 4).

### 1. Prerequisites

- A Hetzner Cloud API token for the project this VM will live in
  (`TF_VAR_hcloud_token`, or a git-ignored `terraform.tfvars` — see
  `terraform/terraform.tfvars.example`).
- DNS control for `announce.aztec.network` — you will need to create an A
  record once the VM exists (step 4).
- An SSH public key that is **different key material from any other
  Hetzner module's key in the same project** (e.g. `aztec-observability`'s)
  — Hetzner rejects a duplicate fingerprint outright and the apply fails.
- The CIDR(s) that should be allowed to reach port 22
  (`operator_ssh_cidrs`). There is no tailnet on this deployment: this
  firewall rule is the only thing standing between the VM and the whole
  internet on that port. This variable has **no default** — Terraform
  refuses to plan without it, on purpose. Never set it to `0.0.0.0/0`.

### 2. `terraform apply`

```sh
cd infra/terraform
terraform init
terraform apply
```

See `terraform/README.md` for the full required-order rationale and the
`prevent_destroy` note on the data volume. **Verify:** the apply prints
`announce_server_ipv4`, `announce_server_name`, `announce_data_volume_id`,
and `domain` as outputs. `terraform/ansible/inventory.yml.tftpl` is
rendered to `infra/ansible/inventory.yml` (gitignored) automatically as
part of the apply — do not hand-write it; see
`infra/ansible/inventory.yml.example` for its shape if you want to look
before applying.

### 3. The DNS A record — and confirming it has actually propagated

Point an A record for `announce.aztec.network` at the `announce_server_ipv4`
output from step 2, in whatever system controls the `aztec.network`
nameservers.

**This is a hard prerequisite for step 5, not a nice-to-have.** Caddy
performs its ACME challenge for `announce.aztec.network` on first run. If
the A record has not propagated yet, the challenge fails, and that failure
surfaces inside Ansible/Caddy — it looks like something is broken in the
playbook or the Terraform, and it is not; the domain simply doesn't resolve
to this host yet.

**Verify propagation before running Ansible:**

```sh
dig +short announce.aztec.network
```

Compare the output to the `announce_server_ipv4` value from step 2. Do not
proceed to step 5 until they match. If you query a resolver that has
cached the old (or no) answer, either wait for the TTL to expire or query a
public resolver directly, e.g. `dig +short announce.aztec.network @1.1.1.1`.

### 4. Running Ansible

```sh
cd infra/ansible
ansible-galaxy collection install -r requirements.yml
ansible-playbook -i inventory.yml site.yml
```

**Before this step**, `{{ stack_dir }}/.env` (`/opt/announce/.env`) must
exist on the host — Ansible deliberately does not template it (it is a
real secret file). Create it by hand over SSH first; the exact keys needed,
and a note on why every value with a space must be quoted, are in
`infra/ansible/inventory.yml.example`'s header comment. Do this before
running the playbook, or `compose_up`'s "Confirm the environment file
exists" task fails immediately with a message pointing back here.

Roles run in this order (see `site.yml`'s own comment for the full
reasoning): `docker` → `volume_mount` → `compose_up` → `fail2ban` →
`cert_reload`. Notably, `compose_up` also generates a short-lived (7-day)
self-signed placeholder certificate for Postgres on first run — this
breaks the chicken-and-egg problem where Postgres needs a cert to start
but nothing can install a real one until Postgres is running —
and `cert_reload` runs once, unconditionally, at the end of the same play
to replace it with Caddy's real Let's Encrypt certificate.

**Verify:**

```sh
ssh root@<announce_server_ipv4> 'docker compose -f /opt/announce/docker-compose.yml ps'
```

Expect `db`, `signal`, `caddy`, and `backup` all `Up`/`healthy`.
`signal-receive` will restart-loop until a Signal account is registered
(step 0) — that is expected and unrelated to whether the deploy succeeded.

```sh
echo | openssl s_client -connect announce.aztec.network:443 2>/dev/null | openssl x509 -noout -issuer -dates
```

Expect a Let's Encrypt issuer and a `notAfter` roughly 90 days out — not
the bootstrap placeholder's `CN=announce-bootstrap-placeholder`,
self-signed, 7-day cert. If you still see the placeholder shortly after
the playbook finished, the `cert_reload` role's post-deploy run may have
failed; check `/var/log/announce-cert-reload.log` on the host and the
alert email (if `ALERT_EMAIL_TO` is set in `.env`).

**Also close the client-side chain, before pointing Netlify at this VM.**
The check above exercises Caddy on port 443 — a different protocol, and
not what Netlify's functions connect to. What they actually connect to is
Postgres on port 5432, verifying against `DATABASE_SSL_ROOT_CERT` (the
ISRG Root X1 certificate — see step 7). Prove that chain closes, run from
a machine OTHER than the VM itself (a local trust store or stale resolver
on the VM would hide a real failure):

```sh
curl -o isrgrootx1.pem https://letsencrypt.org/certs/isrgrootx1.pem
openssl s_client -connect announce.aztec.network:5432 -starttls postgres \
  -CAfile isrgrootx1.pem -verify_return_error </dev/null
```

The only acceptable result is `Verify return code: 0 (ok)`. Anything else
— in particular `UNABLE_TO_VERIFY_LEAF_SIGNATURE` — means the value that
will go into `DATABASE_SSL_ROOT_CERT` is wrong (most likely the VM's own
leaf certificate was pasted instead of ISRG Root X1) and Netlify's
functions will fail to connect from the first deploy. Run this again after
every renewal-adjacent change; it is the only check in this runbook that
proves the client-side chain, not just that Caddy has a valid cert.

### 5. `alter role announce_app with login password ...`

`migrations/014_app_role.sql` (already applied as part of the app's normal
migration run — `npm run migrate`, from wherever that is invoked in your
deploy pipeline) creates `announce_app` **`NOLOGIN`**, on purpose, with no
password at all. Until this step runs, the role cannot connect —
regardless of grants:

```sh
psql "$DATABASE_URL" -c "alter role announce_app with login password '$(openssl rand -base64 32)';"
```

Run this once, as the `announce` owner, against the real deployed database.
Store the generated password only in Netlify's environment variables (as
part of `DATABASE_URL` — see step 7), never in git.

**Do not skip this step, and know what it looks like if you do.**
`NOLOGIN` fails closed: a connection attempt as `announce_app` before this
step produces `FATAL: role "announce_app" is not permitted to log in` —
but that is the message from `psql`/direct Postgres tooling. **The
running app, connecting through `postgres.js`, reports this as `password
authentication failed for user "announce_app"`**, not "not permitted to log
in" — postgres.js does not surface Postgres's distinction between "no such
login privilege" and "wrong password" any differently. An operator
debugging that error will naturally suspect a wrong or corrupted password
and go looking for a credential problem — the actual fix (run this `alter
role` statement) is easy to miss if you don't already know the role starts
`NOLOGIN`. If the app or worker logs `password authentication failed for
user "announce_app"` and you have *not* yet run the command above, this is
why — run it, not a password rotation.

**Verify:**

```sh
psql "$DATABASE_URL" -c "select rolcanlogin from pg_roles where rolname = 'announce_app';"
```

Expect `t`.

### 6. Seeding the first publisher

```sh
DATABASE_URL='postgres://announce_app:<password>@announce.aztec.network:5432/announce' \
  npm run seed:publisher -- you@example.com
```

(Or run it with the `announce` owner's `DATABASE_URL` if you prefer — the
script only needs `INSERT`/`SELECT` on `publishers`, which both roles
have.) The root README's "Startup safety checks" section requires at least
one row in `publishers` before the admin app is safe to expose; while the
table is empty, every identity is treated as a publisher (see root
`README.md`, "Publishers and the bootstrap rule").

**Verify:** the command itself prints the current publisher list after
inserting — confirm the email you passed appears in it.

### 7. Netlify environment variables

These point the Netlify-hosted app and worker (`tick-background` function)
at this VM. Set them in the Netlify site's environment configuration, not
in this repo:

| Variable | Value | Why |
|----------|-------|-----|
| `DATABASE_URL` | `postgres://announce_app:<password from step 5>@announce.aztec.network:5432/announce` | **Do not put `sslmode` or `sslrootcert` in this URL's query string.** `src/db/connect.ts` refuses to build a connection if either is present — they would otherwise let `postgres.js` bypass `DATABASE_SSL_MODE`/`DATABASE_SSL_ROOT_CERT` below entirely, including via a `?sslmode=require` (encrypted-but-unverified) that every Postgres tutorial suggests. |
| `DATABASE_SSL_MODE` | `verify-full` | The only accepted value once the database is reachable over the public internet. `require` is refused outright (see `connect.ts`'s comment for why: it stops a passive eavesdropper, not an active one). |
| `DATABASE_SSL_ROOT_CERT` | **the ISRG Root X1 certificate** — download it from `https://letsencrypt.org/certs/isrgrootx1.pem` and paste its PEM content directly, the full text from `-----BEGIN CERTIFICATE-----` through `-----END CERTIFICATE-----` | Required whenever `DATABASE_SSL_MODE=verify-full` — without it, verification falls back to the system trust store, which is a false sense of security, not a lesser one. **Do not paste the VM's own certificate, and do not paste anything out of Caddy's ACME storage.** Postgres serves the LEAF certificate for `announce.aztec.network` (the file `cert-reload.sh.j2` copies out of Caddy's storage into `server.crt`) — that is what the client receives on the wire, not what it verifies against. TLS verification checks the leaf against its ISSUER, and the issuer of a Let's Encrypt leaf is Let's Encrypt's own root, ISRG Root X1 — a fixed, long-lived certificate that does not change across renewals. Pasting the leaf (or `server.crt`, or anything Caddy stores) fails immediately with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; the correct value is the root CA, obtained independently of this VM. **On Netlify this must be the inline PEM value, not a path** — a serverless function has no filesystem to hold a CA file on. `resolveCaFile` (`src/db/connect.ts`) detects inline PEM by its `-----BEGIN CERTIFICATE-----` header and uses it directly; anything that doesn't start with that header is instead treated as a filesystem path and read from disk — that's the form used elsewhere on this host and by local dev, where a real file naturally exists (e.g. `infra/dev/certs/ca.crt` locally; on the VM itself, this same ISRG Root X1 PEM, not anything derived from Caddy's storage). If Netlify's UI flattens the pasted value's newlines into literal `\n` characters, `resolveCaFile` detects and un-escapes that automatically — a known failure mode for certificates pasted through some web UIs, not something you need to work around by hand. |
| `SIGNAL_API_BASE` | `https://announce.aztec.network` | Reaches the Signal sidecar through Caddy's reverse proxy, not directly — the sidecar itself is never published to the host. |
| `SIGNAL_API_SECRET` | the same value as `ANNOUNCE_SIGNAL_SECRET` in `/opt/announce/.env` on the VM | Sent as the `x-announce-signal-secret` header (`src/core/signal-auth.ts`) and checked by `infra/Caddyfile.split`'s gate. The two values must match exactly, or every Signal request 403s. |
| `ENABLED_CHANNELS` | e.g. `webhook,discord,telegram,email` — **must NOT include `signal`** | Netlify has no Signal account registered yet (step 0), and `src/core/production-guard.ts`'s startup guard refuses to boot the Netlify shape if `ENABLED_CHANNELS` is unset (which defaults to all five, including Signal) or explicitly names `signal`. Add `signal` here only after a real number is registered and `SIGNAL_API_SECRET`/`SIGNAL_API_BASE` are both live and verified. |

**Verify:** after deploying with these set, confirm the Netlify build/runtime
logs show no `production-guard` startup failure, and that a real request to
the admin UI resolves an identity rather than showing "Admin is
unavailable". See the root `README.md`'s Configuration table for the full
variable list (Auth0, session secret, etc.) — this table only covers the
five that point at this VM specifically.

## The security note

**Read this before operating this deployment.** Postgres (5432) and the
Signal proxy (443, via Caddy) are reachable from the public internet. There
is no tailnet, no VPN, and no IP allowlist in front of either — the
Hetzner firewall (`infra/terraform/vm.tf`) opens both to `0.0.0.0/0` and
`::/0` on purpose, because Netlify's egress pool has no stable IP range to
allowlist against.

**What the database holds:** the Discord webhook URL and the Telegram bot
token (`channel_settings`), every subscriber's email address
(`subscriptions.endpoint`), per-subscriber webhook signing secrets
(`subscriptions.secret`), and the publisher list (`publishers`) — the
four-eyes identity list that decides who may author and who may confirm a
critical announcement.

**A write is worse than a read.** A leaked read-only credential exposes
that data. A leaked credential that can *write* to `publishers` is worse:
inserting a row there lets an attacker manufacture both halves of four-eyes
themselves — one identity to author a critical announcement, a second to
confirm it — without ever touching `audit_log` or `delivery_ledger`, so
nothing in the audit trail would even show tampering. This is exactly why
`announce_app` (the role the running app connects as — see above) has only
`SELECT` on `publishers` and `channel_settings`, never `INSERT` or
`UPDATE`; adding a publisher stays an owner-run, out-of-band action
(`npm run seed:publisher`), never something the app itself can do.

**What protects this, and why each layer matters:**
1. **Verified TLS** (`DATABASE_SSL_MODE=verify-full` with an explicit CA,
   enforced in `src/db/connect.ts`) — stops both passive eavesdropping and
   an active attacker who can redirect the connection, unlike
   `sslmode=require`, which only stops the former.
2. **The least-privilege `announce_app` role** (`NOLOGIN` until step 5, no
   `DROP`/`TRUNCATE`/`ALTER` ever, no `DELETE` on the append-only audit
   tables, read-only on `publishers`/`channel_settings`) — bounds the
   damage a leaked application credential (not a leaked superuser
   credential — that is a different, worse incident) can do.
3. **`fail2ban`** (`infra/ansible/roles/fail2ban`) — rate-limits repeated
   failed connection attempts against 5432, the layer that stops
   brute-force/credential-stuffing against the port itself, which TLS and
   the role's grants do not address on their own.
4. **The SSH CIDR restriction** (`operator_ssh_cidrs`) — the only path to
   port 22, since there is no tailnet `ssh` fallback here.

None of these four is optional, and none compensates for a failure in
another — removing any one weakens the justification for the others. An
operator who does not know what this VM exposes, and why, cannot maintain
it safely: a "harden this later" instinct on any one of these four is a
live security regression, not a convenience.

## What has not been verified — read before you rely on this

Nobody has applied this Terraform or run this Ansible against a real VM.
Real Docker containers, real TLS handshakes, and real fault injection *were*
used extensively during development (see
`.superpowers/sdd/2026-08-27-06b-split-infrastructure/task-5-report.md` and
`task-6-report.md` for exact commands and output) — that work is real and
should not be discounted. But several things can only get their first real
exercise on an actual apply, and you should know which before relying on
them:

- **Real ACME issuance and the ~day-60 renewal against Let's Encrypt for
  `announce.aztec.network`.** The cert-reload hook's own logic (detecting
  a changed cert, copying it into Postgres, confirming Postgres accepted
  the reload via its own log line rather than assuming) was proven against
  a *seeded* stand-in certificate placed to simulate what a real renewal
  produces — not against an actual Caddy renewal event. DNS reachability,
  challenge completion, and Let's Encrypt's own rate limits are all
  unexercised.
- **The client-side trust chain (Netlify → Postgres over `verify-full`)
  has never been verified against a real Let's Encrypt certificate.** Every
  local proof that TLS verification works used
  `infra/dev/gen-test-certs.sh`, which generates a single self-signed
  certificate and points both the server and `DATABASE_SSL_ROOT_CERT` at
  it — the client's trusted CA and the server's own certificate are the
  SAME file by construction. That is not the topology this deployment
  actually has: with Let's Encrypt, the server presents a LEAF certificate
  and the client must trust the ISSUER (ISRG Root X1), two different
  certificates. Nothing in this branch's test suite or local proofs
  exercises that two-certificate chain; the `openssl s_client -starttls
  postgres` command in step 4 above is the first point this chain gets
  checked at all, and it has not yet been run against a real deployment.
- **The Hetzner firewall's real behaviour.** No Hetzner resources were ever
  created during development; the firewall rules in `vm.tf` were validated
  by `terraform plan`/`validate` against the real Hetzner API, not by
  actual traffic hitting a real, applied firewall.
- **`RequiresMountsFor` under an actual reboot.** The systemd drop-in that
  stops Docker starting Postgres before the data volume is mounted was
  checked with `ansible-lint`/`--syntax-check` only — the boot-race
  scenario it exists to close needs a real reboot (or rescue-mode rebuild)
  of a real Hetzner volume to observe directly. The development sandbox
  had no systemd and no real boot sequence.
- **`fail2ban-client status <jail>` on a live jail.** The regex was proven
  correct against real captured Postgres log lines from a real container
  (six real failed logins, all six correctly matched and IP-extracted),
  but `fail2ban` itself could not be installed in the development sandbox
  (no root/apt access) — so the jail has never actually banned a real
  repeated-failure source IP end to end.
- **A full, non-syntax-check `ansible-playbook` run against a live host.**
  Only `--syntax-check` and `ansible-lint` (clean at the `production`
  profile) were run — there was no real inventory host to target. The
  first real `ansible-playbook -i inventory.yml site.yml` run in step 4
  above is this playbook's first real execution.
- **The cert-reload hook's 8-second polling window, sized against a
  lightly-loaded sandbox.** After a SIGHUP, the script polls Postgres's own
  log for up to 8 seconds to confirm the reload was accepted (not just
  that the file on disk changed — see `cert-reload.sh.j2`'s fix-round-3
  comments for why a bare file-hash or `pg_stat_ssl` check was proven
  insufficient). The 8-second ceiling is based on a ~57ms measured
  logging-driver flush time in the development sandbox, giving roughly two
  orders of magnitude of headroom — but that measurement was taken under
  light load, not real production disk/CPU contention. If it is ever too
  short under real load, the failure mode is a false "UNCONFIRMED — check
  manually" alert, not a silent false success (see the polling logic's own
  comments for the distinct outcomes it reports).
- **The Ansible bootstrap-cert task's "no network dependency" property**
  against a genuine host `openssl` binary on a genuine target host — the
  development sandbox had no root access to a real Docker volume
  mountpoint, so this was proven with a substitute (a throwaway container
  mounting the named volume), not the actual Ansible task path.

What *was* proven, with real Docker containers, and is not merely reasoned
about: TLS handshakes against both the bootstrap placeholder and injected
certs; certificate rejection with a wrong CA; the Signal proxy's
fail-closed behavior (missing header, wrong header, unset secret — all
403, verified with `docker compose up` itself refusing to start without
`ANNOUNCE_SIGNAL_SECRET` set); the cert-reload hook firing end-to-end
against a seeded cert, including its ambiguous-multi-issuer refusal,
incomplete-pair detection, and rejected-SIGHUP detection (a deliberately
mismatched key, confirmed via `openssl s_client` that Postgres kept serving
the *old* certificate while the naïve checks would have reported success);
and the fail2ban filter regex against real captured Postgres auth-failure
log lines. See the two task reports for full command transcripts.
