# Infra notes

## Database role: `announce_app`

`migrations/014_app_role.sql` creates a least-privilege Postgres role,
`announce_app`, for the application to connect as. The application does
not connect as the database owner (`announce`). This matters once
Postgres's port is reachable from the public internet (the split
deployment), and not only from a private network. A leaked application
credential must not be able to run `DROP`, `TRUNCATE`, or `ALTER` on
anything. It must also not be able to run `DELETE` on the two append-only
audit tables (`delivery_ledger`, `audit_log`).

**What `announce_app` can do:**
- `SELECT`/`INSERT`/`UPDATE` on `announcements`.
- `SELECT`/`INSERT`/`UPDATE` on `delivery_ledger` and `alert_state`.
- `SELECT`/`INSERT` on `audit_log`. No `UPDATE`, no `DELETE`.
- Full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `templates` and
  `subscriptions`. These are the only two tables the application code
  deletes from (`src/core/templates.ts`, `src/core/tokens-flow.ts`).
- `SELECT` only on `channel_settings` and `publishers`.

See the comment block at the top of `migrations/014_app_role.sql` for the
full reasoning, including:

- `delivery_ledger` and `audit_log` do not get `DELETE`, even though the
  local dev/test reset tooling (`scripts/reset-test-data.ts`,
  `test/helpers.ts`) deletes from and truncates them. Those tools run as
  the `announce` owner, not as the app.
- `channel_settings` and `publishers` are read-only for the app. An
  earlier version of this migration granted `INSERT`/`UPDATE` on both.
  Every app touch of either table is a read. The only writes anywhere are
  owner-run operator scripts (`scripts/setup-channel.ts`,
  `scripts/seed-publisher.ts`). `publishers` is the four-eyes identity
  list. If the app role could `INSERT` there, a leaked credential could
  add itself, and a second identity, as publishers. It could then approve
  its own critical announcement without touching either audit table.
  `channel_settings` holds the Discord webhook URL and the Telegram bot
  token. If the app role could `UPDATE` there, a leaked credential could
  silently redirect or break delivery.

No `DROP`, `TRUNCATE`, or `ALTER` is granted to `announce_app`, ever.

### Deploying: setting the real password

The migration creates the role `NOLOGIN`, with no password at all, not
even a placeholder. A committed placeholder password would be a real,
working credential from the moment the migration runs. The port is
reachable from the public internet, so that credential would stay live
until someone remembered to rotate it. `NOLOGIN` fails closed instead. Any
connection attempt as `announce_app` before the step below returns a
loud, immediate error: `FATAL: role "announce_app" is not permitted to log
in`. It does not open a silent door.

After running the migration against a real deployment, enable login with
a real password. Do this as a superuser, using the `announce` owner
credential. There is no separate summary here. Step 5 below, in this file, has
the command and every pitfall around it. The same procedure is step 6 of
[`DEPLOY.md`](DEPLOY.md), which numbers its steps differently.

This command cannot run on the VM. Postgres runs in a container, so the host
has no `postgres` user and no `psql` binary. The command goes over the network
with TLS, as step 5 shows.

Store the generated password only in the deployment's secret manager or
env (for example, as the credential in the application's `DATABASE_URL`).
Never store it in git. Once this step is done, point the application's
`DATABASE_URL` at `announce_app`, not `announce`. In a deployed
environment, the app must never connect as the table owner.
`src/db/migrate.ts` runs at deploy time, separately from the running app.
It still connects as the owner, because it needs `CREATE TABLE`/`ALTER
TABLE` rights that the app role does not have.

### Future tables

`014_app_role.sql` does not use `alter default privileges` to auto-grant
`announce_app` access to tables created later. This is deliberate: each
future migration that adds a table must add its own explicit grant for
`announce_app` in that same migration, or deliberately omit one (for
example, for another append-only audit table). See the comment in
`014_app_role.sql` for the reasoning. A forgotten grant fails closed, with
`permission denied`, not open. That is the correct default for a
credential reachable from the public internet.

## Deploying the split infrastructure — the reference

**To deploy, follow [`DEPLOY.md`](DEPLOY.md).** It is the step-by-step
procedure: the commands, in order, with a check after each one.

This section is the reference behind those steps. It explains why each step
exists, what it protects against, and what happens when it is done wrong. Read
it when a step fails, or before changing the procedure.

This is the procedure for standing up `db.announce.aztec.network`: one
Hetzner VM (Postgres, the Signal sidecar, and Caddy), with the app and
worker running on Netlify, not on this VM.

Follow the steps in order. Several of them exist because running them out
of order produces a failure that looks like a different bug than the one
it actually is. Each such case is noted inline below.

For the Terraform-specific detail behind step 1 (the required apply
order, `prevent_destroy`, and state), see `terraform/README.md`. This
section does not repeat that detail. It covers only the parts of the
procedure that live outside Terraform.

### 0. What this VM provisions, and what it does not

**Provisions:** Postgres (port 5432, publicly reachable — see the
security note below), `signal-cli-rest-api` (not published to the host
directly), and Caddy (port 443). Caddy obtains and renews the Let's
Encrypt certificate for `db.announce.aztec.network` and reverse-proxies to
the Signal sidecar behind a shared-secret gate. The VM also runs a
nightly backup job. See `infra/docker-compose.split.yml`'s top comment
and `infra/Caddyfile.split` for exactly what runs and why.

**Does not provision:**
- **The app or the worker.** Those run on Netlify. This VM has no `app`,
  `worker`, or `migrate` service.
- **A registered Signal account.** `signal-cli-rest-api` comes up, but
  nothing registers a phone number with it. Signal is supported by this
  stack: the sidecar, the Caddy gate, and `signal-receive`'s keep-alive
  job all exist. But Signal is not usable until a number is registered by
  hand. That registration procedure is not documented in this repository.
  It needs a phone number registered with `signal-cli` against the
  running sidecar (`signal-cli-rest-api`'s own docs cover the `register`/
  `verify` flow); do that by hand against this VM's sidecar before adding
  `signal` to Netlify's `ENABLED_CHANNELS` (see step 7).
- **DNS.** Terraform does not manage the `aztec.network` nameservers. The
  A record is a manual step (step 3).

### 1. Prerequisites

- A Hetzner Cloud API token for the project this VM will live in
  (`TF_VAR_hcloud_token`, or a git-ignored `terraform.tfvars` — see
  `terraform/terraform.tfvars.example`).
- A Tailscale API key or OAuth client secret
  (`TF_VAR_tailscale_api_key`, same file-or-env pattern as the Hetzner
  token above). Authenticates the `provider "tailscale"` block in
  `terraform/vm.tf` to `api.tailscale.com`, which is what actually mints
  this VM's tailnet auth key. Without it, `terraform apply` fails
  authenticating, not because the ACL tag is missing — see "The tailnet
  ACL tag" below for how to tell the two failures apart.
- AWS credentials that can read and write the Foundation's Terraform state
  bucket, `aztec-foundation-terraform-state` in `eu-west-2`. `terraform init`
  fails without them. State lives there rather than on one machine, so
  anyone with bucket access can read the outputs this runbook needs. See
  `terraform/versions.tf`. State does not hold only outputs: it also holds
  the plaintext `tailscale_tailnet_key.announce` auth key (see
  `terraform/vm.tf`), the same way it would hold any other secret-bearing
  resource. Bucket access is credential access, not just read access to
  non-sensitive values.
- DNS control for `db.announce.aztec.network`. You will need to create an A
  record once the VM exists (step 3). The person who runs `terraform apply`
  and the person who sets the record do not have to be the same person: the
  apply prints the address, and anyone with state access can read it again
  later with `terraform output announce_server_ipv4`.
- An SSH public key. This key's material must differ from any other
  Hetzner module's key in the same project (for example,
  `aztec-observability`'s). Hetzner rejects a duplicate fingerprint
  outright, and the apply fails. This is no longer the day-2 access path
  (see below). It is not an access path: the Hetzner console is a VNC
  session at a login prompt and never presents this key, and root's password
  is locked on a stock image. Recovery is Hetzner rescue mode.
- The tailnet this VM joins (`var.tailnet`) and its ACL tag
  (`var.tailscale_acl_tag`, `tag:announce` by default). `tailnet` has no
  default: Terraform refuses to plan without it. The tag is a harder
  prerequisite than a variable value — see "The tailnet ACL tag" below.
  It must already exist in the tailnet's ACL before you apply. The common
  failure is not a broken VM: `hcloud_server.announce` depends on
  `tailscale_tailnet_key.announce`, so a missing tag fails key creation and
  `terraform apply` stops there — no server gets created at all. A VM that
  boots and only then finds its tailnet join failing is the less likely,
  worse case; see "The tailnet ACL tag" below for both.
- Your own machine on the same tailnet. Day-2 access to the VM is
  `tailscale ssh`, not a public SSH port. Confirm with `tailscale status`
  before you start.

**The tailnet ACL tag.** `tag:announce` is not created by this module. It
is owned by `rpc.aztec.foundation/tailscale.tf` in
`AztecProtocol/foundation-iac`, a singleton applied with
`overwrite_existing_content = true`. Add the tag there, in code, and apply
that module first. A Tailscale admin-console edit does not survive — that
module's next apply treats it as drift and reverts it. If the tag is
missing when this module applies, `tailscale_tailnet_key.announce`
creation fails, or the failure surfaces later as `tailscale up` rejecting
the auth key in cloud-init, and either way the VM has no way in: no SSH
port, and no working tailnet join. See `terraform/variables.tf`
`tailscale_acl_tag` for the full failure mode.

### 2. `terraform apply`

```sh
cd infra/terraform
terraform init
terraform apply
```

See `terraform/README.md` for the full required-order rationale and the
`prevent_destroy` note on the data volume.

**Verify:** the apply prints `announce_server_ipv4`,
`announce_server_name`, `announce_data_volume_id`, and `domain` as
outputs. `terraform/ansible/inventory.yml.tftpl` is rendered to
`infra/ansible/inventory.yml` (gitignored) automatically as part of the
apply. Do not hand-write it. See `infra/ansible/inventory.yml.example` for
its shape if you want to look before applying.

The public IPv4 is a reserved primary IP (`hcloud_primary_ip.announce`) with
the same protection. Rebuilding the server with
`terraform apply -replace=hcloud_server.announce` keeps both the address and
the volume; `infra/DEPLOY.md` has the procedure under "Rebuilding the VM".

### 3. The DNS A record, and confirming it has propagated

**Why this VM has its own hostname.** The VM answers on
`db.announce.aztec.network`. Netlify serves `announce.aztec.network`, the
app's public site. These are two different hosts. One DNS A record can
point at only one address, so the VM cannot share the public hostname.
The A record you add in this step is for the VM only. It does not change
where `announce.aztec.network` points, and it does not affect the public
site.

Warning: `ANNOUNCE_DOMAIN` in the VM's `/opt/announce/.env` must match
the Terraform `domain` value exactly. Caddy requests its Let's Encrypt
certificate for whatever `ANNOUNCE_DOMAIN` names. If the two values
disagree, the ACME challenge fails, and the failure looks like a DNS
problem rather than a configuration mismatch.

Point an A record for `db.announce.aztec.network` at the
`announce_server_ipv4` output from step 2, in whatever system controls
the `aztec.network` nameservers.

`terraform apply` prints that address when it finishes. To read it again
later, run `terraform output announce_server_ipv4` from `infra/terraform/`.
State is in the shared bucket, so this works from any machine with access,
not only the one that applied.

**This is a hard prerequisite for step 4, not an optional check.** Caddy
performs its ACME challenge for `db.announce.aztec.network` on first run. If
the A record has not propagated yet, the challenge fails. That failure
surfaces inside Ansible or Caddy, and it looks like something is broken
in the playbook or the Terraform. It is not: the domain simply does not
resolve to this host yet.

**Verify propagation before running Ansible:**

```sh
dig +short db.announce.aztec.network
```

Compare the output to the `announce_server_ipv4` value from step 2. Do
not proceed to step 4 until they match. If you query a resolver that has
cached the old answer, or no answer, either wait for the TTL to expire or
query a public resolver directly, for example
`dig +short db.announce.aztec.network @1.1.1.1`.

### 4. Running Ansible

```sh
cd infra/ansible
ansible-galaxy collection install -r requirements.yml
ansible-playbook -i inventory.yml site.yml
```

**Before this step**, `{{ stack_dir }}/.env` (`/opt/announce/.env`) must
exist on the host. Ansible does not template it, because it is a real
secret file. Create it by hand over SSH first. The exact keys needed, and
a note on why every value with a space must be quoted, are in
`infra/ansible/inventory.yml.example`'s header comment. Do this before
running the playbook. If you skip it, `compose_up`'s "Confirm the
environment file exists" task fails immediately, with a message pointing
back here.

Roles run in this order (see `site.yml`'s own comment for the full
reasoning): `docker`, then `volume_mount`, then `compose_up`, then
`fail2ban`, then `cert_reload`. `compose_up` also generates a short-lived
(7-day) self-signed placeholder certificate for Postgres on first run.
This solves a chicken-and-egg problem: Postgres needs a certificate to
start, but nothing can install a real one until Postgres is running.
`cert_reload` then runs once, unconditionally, at the end of the same
play, to replace the placeholder with Caddy's real Let's Encrypt
certificate.

**Verify:**

```sh
tailscale ssh root@<announce_server_name> 'docker compose -f /opt/announce/docker-compose.yml ps'
```

Expect `db`, `signal`, `caddy`, and `backup` all `Up`/`healthy`.
`signal-receive` will restart-loop until a Signal account is registered
(step 0). That is expected, and unrelated to whether the deploy
succeeded.

```sh
echo | openssl s_client -connect db.announce.aztec.network:443 2>/dev/null | openssl x509 -noout -issuer -dates
```

Expect a Let's Encrypt issuer and a `notAfter` roughly 90 days out. You
should not see the bootstrap placeholder's `CN=announce-bootstrap-placeholder`,
self-signed, 7-day certificate. If you still see the placeholder shortly
after the playbook finished, the `cert_reload` role's post-deploy run may
have failed. Check `/var/log/announce-cert-reload.log` on the host, and
the alert email if `ALERT_EMAIL_TO` is set in `.env`.

**Also close the client-side chain, before pointing Netlify at this VM.**
The check above exercises Caddy on port 443. That is a different
protocol, and not what Netlify's functions connect to. What they connect
to is Postgres on port 5432, verifying against `DATABASE_SSL_ROOT_CERT`
(the ISRG Root X1 certificate — see step 7).

Warning: to prove that chain closes, run the command below from a machine
other than the VM itself. A local trust store or a stale resolver on the
VM would hide a real failure.

```sh
curl -o isrgrootx1.pem https://letsencrypt.org/certs/isrgrootx1.pem
openssl s_client -connect db.announce.aztec.network:5432 -starttls postgres \
  -CAfile isrgrootx1.pem -verify_return_error \
  -verify_hostname db.announce.aztec.network </dev/null
```

The only acceptable result is `Verify return code: 0 (ok)`. Any other
result, in particular `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, means the value
that will go into `DATABASE_SSL_ROOT_CERT` is wrong. The most likely
cause is that the VM's own leaf certificate was pasted instead of ISRG
Root X1. If this check fails, Netlify's functions will fail to connect
from the first deploy. Run this check again after every renewal-adjacent
change. It is the only check in this runbook that proves the client-side
chain, not just that Caddy has a valid certificate.

### 5. Apply the migration, then set the `announce_app` password

Both commands in this step use the `announce` owner credential, the one
with full rights. This is not the least-privilege `announce_app` role
used from step 6 onward.

**Run both commands from your own machine, not the VM.** There is no
Node runtime, no `npm`, and no application code on this VM at all —
`docker-compose.split.yml` has no `app`, `worker`, or `migrate` service,
and `compose_up`'s repo sync deliberately excludes `node_modules`. The
commands below go over the internet to
`db.announce.aztec.network:5432`, so both must use verified TLS
explicitly. This is different from the pre-split deployment shape, where
the same commands ran over Tailscale against a private address.

**Apply `migrations/014_app_role.sql` first**, and every other pending
migration, using the app's own migration entrypoint from a checkout of
this repo (`npm install` already run — see the root `README.md`), as the
owner. Run every command in this section from the repo root (the
directory with `package.json` in it) — this is also where the
`isrgrootx1.pem` from step 4 of this file (step 5 of `DEPLOY.md`) should be
downloaded, so both live in one place:

```sh
export DATABASE_SSL_MODE=verify-full DATABASE_SSL_ROOT_CERT="$PWD/isrgrootx1.pem"
```

```sh
DATABASE_URL='postgres://announce:<owner password>@db.announce.aztec.network:5432/announce' \
  npm run migrate
```

`npm run migrate` (`src/db/migrate-cli.ts`) routes through
`buildConnectionOptions`/`resolveCaFile`, the same TLS-enforcing path the
app itself uses. `DATABASE_SSL_MODE=verify-full` plus an explicit
`DATABASE_SSL_ROOT_CERT` is not optional here: this connection crosses
the public internet, and `buildConnectionOptions`'s `case undefined`
leaves `ssl` unset entirely if `DATABASE_SSL_MODE` is left unset — the
same behavior local dev relies on, which would send the owner credential,
the most powerful credential in this system, over the internet with no
TLS at all, with no error. Exporting both once, as shown above, means
there is one place to get this right instead of retyping it on every
command in this section.

Warning: do not put `sslmode` or `sslrootcert` in `DATABASE_URL`'s query
string. `buildConnectionOptions` refuses to run if either is present —
see step 7's table for why. Use the exported `DATABASE_SSL_*` variables
instead.

`migrations/014_app_role.sql` creates `announce_app` `NOLOGIN`, on
purpose, with no password at all. Until the `alter role` command below
runs, the role cannot connect, regardless of its grants. This prints the
password once — capture it now, you need it in step 7:

```sh
APP_PW="$(openssl rand -base64 32)"
PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/isrgrootx1.pem" \
  psql "postgres://announce:<owner password>@db.announce.aztec.network:5432/announce" \
  -c "alter role announce_app with login password '$APP_PW';"
printf 'announce_app password: %s\n' "$APP_PW"
```

Warning: psql's default `sslmode` is `prefer`. It negotiates TLS
opportunistically, but falls back to plaintext silently, and never
verifies the server either way. Running this command without the
`PGSSLMODE=verify-full PGSSLROOTCERT=...` prefix shown above would send
the freshly generated password across the internet as literal plaintext,
inside the SQL statement itself. This is worse than a plaintext
connection alone, because the text being sent is the secret you are
trying to protect.

Two more things that catch operators out on this exact command:

- `openssl rand -base64 32` can emit `/` and `+` in its output. Both must
  be percent-encoded if you place this password into a `DATABASE_URL`'s
  userinfo section (step 7). An unencoded `/` or `+` there produces an
  opaque connection-string parse error, not a clear "bad character"
  message.
- The password is now in your shell history, in `$APP_PW`, and in the
  printed output above. Copy it into Netlify's environment variables
  (step 7) now, then clear your history (`history -d`, or your shell's
  equivalent). If you lose it anyway, re-run the `alter role` command
  with a new password — nothing else in this system depends on the old
  value.

Store the generated password only in Netlify's environment variables (as
part of `DATABASE_URL` — see step 7). Never store it in git.

**Do not skip the `alter role` step. Know what a skipped step looks
like.** `NOLOGIN` fails closed: a connection attempt as `announce_app`
before this step produces `FATAL: role "announce_app" is not permitted to
log in`. That is the message from `psql` and other direct Postgres
tooling. The running app connects through `postgres.js` instead, and
reports the same problem differently: `password authentication failed for
user "announce_app"`. `postgres.js` does not distinguish Postgres's "no
login privilege" error from a "wrong password" error. An operator
debugging that message will naturally suspect a wrong or corrupted
password, and go looking for a credential problem. The actual fix, running
this `alter role` statement, is easy to miss if you do not already know
the role starts `NOLOGIN`. If the app or worker logs `password
authentication failed for user "announce_app"`, and you have not yet run
the command above, this is why. Run the command, not a password rotation.

**Verify** (from the same machine, directory, and session — the exported
`DATABASE_SSL_*`/`$APP_PW` above are still in effect):

```sh
PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/isrgrootx1.pem" \
  psql "postgres://announce:<owner password>@db.announce.aztec.network:5432/announce" \
  -c "select rolcanlogin from pg_roles where rolname = 'announce_app';"
```

Expect `t`.

### 6. Seeding the first publisher

This step, like the `alter role` step above, is an owner-run, out-of-band
action. `announce_app` cannot do it. `migrations/014_app_role.sql` grants
`announce_app` `SELECT` only on `publishers`, with no `INSERT`.
`publishers` is the four-eyes identity list. A credential that could
insert its own row there could manufacture both halves of the approval
itself (see "The security note" below). Run this as the `announce`
owner, from the same machine, directory, and session as step 5 — the
`DATABASE_SSL_MODE`/`DATABASE_SSL_ROOT_CERT` you exported there are still
in effect:

```sh
DATABASE_URL='postgres://announce:<owner password>@db.announce.aztec.network:5432/announce' \
  npm run seed:publisher -- you@example.com
```

Running this command as `announce_app` instead fails with `permission
denied for table publishers`. That is expected and correct, not a bug in
the migration. It is proof that the grant in `migrations/014_app_role.sql`
is doing its job.

Warning: `scripts/seed-publisher.ts` goes through `src/db/connect.ts`, the
same TLS-enforcing path as the app itself. Leaving out
`DATABASE_SSL_MODE=verify-full` and `DATABASE_SSL_ROOT_CERT` would send
the owner credential across the internet with no TLS at all — see step
5's warning. There is no VM-local fallback for this command: this VM has
no Node runtime to run it with.

The root README's "Startup safety checks" section requires at least one
row in `publishers` before the admin app is safe to expose. While the
table is empty, every identity is treated as a publisher (see root
`README.md`, "Publishers and the bootstrap rule").

**Verify:** the command itself prints the current publisher list after
inserting. Confirm the email you passed appears in it.

### 7. Netlify environment variables

These variables point the Netlify-hosted app and worker
(`tick-background` function) at this VM. Set them in the Netlify site's
environment configuration, not in this repo:

| Variable | Value | Why |
|----------|-------|-----|
| `DATABASE_URL` | `postgres://announce_app:<password from step 5>@db.announce.aztec.network:5432/announce` | Do not put `sslmode` or `sslrootcert` in this URL's query string. `src/db/connect.ts` refuses to build a connection if either is present. Otherwise they could let `postgres.js` bypass `DATABASE_SSL_MODE`/`DATABASE_SSL_ROOT_CERT` below entirely, including through a `?sslmode=require` value (encrypted but unverified) that every Postgres tutorial suggests. |
| `DATABASE_SSL_MODE` | `verify-full` | This is the only accepted value once the database is reachable over the public internet. `require` is refused outright. See `connect.ts`'s comment for why: `require` stops a passive eavesdropper, but not an active one. |
| `DATABASE_SSL_ROOT_CERT` | The ISRG Root X1 certificate. Download it from `https://letsencrypt.org/certs/isrgrootx1.pem` and paste its PEM content directly, the full text from `-----BEGIN CERTIFICATE-----` through `-----END CERTIFICATE-----`. | Required whenever `DATABASE_SSL_MODE=verify-full`. Without it, verification falls back to the system trust store. That gives a false sense of security, not a lesser one. Warning: do not paste the VM's own certificate, and do not paste anything out of Caddy's ACME storage. Postgres serves the leaf certificate for `db.announce.aztec.network` (the file `cert-reload.sh.j2` copies out of Caddy's storage into `server.crt`). That is what the client receives on the wire, not what it verifies against. TLS verification checks the leaf against its issuer. The issuer of a Let's Encrypt leaf is Let's Encrypt's own root, ISRG Root X1. ISRG Root X1 is a fixed, long-lived certificate that does not change across renewals. Pasting the leaf, `server.crt`, or anything Caddy stores fails immediately with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The correct value is the root CA, obtained independently of this VM. On Netlify this value must be the inline PEM value, not a path: a serverless function has no filesystem to hold a CA file on. `resolveCaFile` (`src/db/connect.ts`) detects inline PEM by its `-----BEGIN CERTIFICATE-----` header and uses it directly. Anything that does not start with that header is instead treated as a filesystem path and read from disk. That form is used elsewhere on this host and by local dev, where a real file naturally exists (for example, `infra/dev/certs/ca.crt` locally; on the VM itself, this same ISRG Root X1 PEM, not anything derived from Caddy's storage). If Netlify's UI flattens the pasted value's newlines into literal `\n` characters, `resolveCaFile` detects and un-escapes that automatically. This is a known failure mode for certificates pasted through some web UIs, not something you need to work around by hand. |
| `SIGNAL_API_BASE` | `https://db.announce.aztec.network` | Reaches the Signal sidecar through Caddy's reverse proxy, not directly. The sidecar itself is never published to the host. |
| `SIGNAL_API_SECRET` | The same value as `ANNOUNCE_SIGNAL_SECRET` in `/opt/announce/.env` on the VM. | Sent as the `x-announce-signal-secret` header (`src/core/signal-auth.ts`) and checked by `infra/Caddyfile.split`'s gate. The two values must match exactly, or every Signal request returns 403. |
| `ENABLED_CHANNELS` | For example `webhook,discord,telegram,email`. Must not include `signal`. | Netlify has no Signal account registered yet (step 0). `src/core/production-guard.ts`'s startup guard refuses to boot the Netlify shape if `ENABLED_CHANNELS` is unset (which defaults to all five, including Signal) or explicitly names `signal`. Add `signal` here only after a real number is registered, and after `SIGNAL_API_SECRET`/`SIGNAL_API_BASE` are both live and verified. |

**Verify:** after deploying with these set, confirm the Netlify build and
runtime logs show no `production-guard` startup failure, and that a real
request to the admin UI resolves an identity rather than showing "Admin
is unavailable". See the root `README.md`'s Configuration table for the
full variable list (Auth0, session secret, and so on). This table covers
only the five variables that point at this VM specifically.

## The security note

**Read this before operating this deployment.** Postgres (5432) and the
Signal proxy (443, via Caddy) are reachable from the public internet. This
is unchanged since operator access moved onto the tailnet (2026-08-31):
there is still no VPN and no IP allowlist in front of either port. The
Hetzner firewall (`infra/terraform/vm.tf`) opens both to `0.0.0.0/0` and
`::/0` on purpose, because Netlify's egress pool has no stable IP range
to allowlist against. The tailnet protects only operator access (SSH);
it does not sit in front of 5432 or 443, and does not reduce what those
two ports expose.

**What the database holds:** the Discord webhook URL and the Telegram
bot token (`channel_settings`), every subscriber's email address
(`subscriptions.endpoint`), per-subscriber webhook signing secrets
(`subscriptions.secret`), and the publisher list (`publishers`). The
publisher list is the four-eyes identity list. It decides who may author
and who may confirm a critical announcement.

**A write is worse than a read.** A leaked read-only credential exposes
that data. A leaked credential that can write to `publishers` is worse.
Inserting a row there lets an attacker manufacture both halves of
four-eyes: one identity to author a critical announcement, and a second
to confirm it, without ever touching `audit_log` or `delivery_ledger`.
Nothing in the audit trail would show tampering. This is why
`announce_app` (the role the running app connects as — see above) has
only `SELECT` on `publishers` and `channel_settings`, never `INSERT` or
`UPDATE`. Adding a publisher stays an owner-run, out-of-band action
(`npm run seed:publisher`), never something the app itself can do.

**What protects this, and why each layer matters:**
1. **Verified TLS** (`DATABASE_SSL_MODE=verify-full` with an explicit CA,
   enforced in `src/db/connect.ts`). This stops both passive
   eavesdropping and an active attacker who can redirect the connection.
   `sslmode=require` only stops the former.
2. **The least-privilege `announce_app` role** (`NOLOGIN` until step 5,
   no `DROP`/`TRUNCATE`/`ALTER` ever, no `DELETE` on the append-only
   audit tables, read-only on `publishers`/`channel_settings`). This
   bounds the damage a leaked application credential can do. A leaked
   superuser credential is a different, worse incident.
3. **`fail2ban`** (`infra/ansible/roles/fail2ban`). This rate-limits
   repeated failed connection attempts against 5432. It is the layer that
   stops brute-force and credential-stuffing attacks against the port
   itself, which TLS and the role's grants do not address on their own.
4. **Operator access over the tailnet, not a public SSH port**
   (`var.tailnet`/`var.tailscale_acl_tag`, `terraform/vm.tf`). Port 22 is
   closed in the Hetzner firewall; day-2 access is `tailscale ssh`, which
   needs no inbound port of its own. This protects operator access only —
   it does nothing for 5432 or 443, which stay open to `0.0.0.0/0` and
   `::/0` as described above. The `ssh_public_key` variable still exists,
   but it is not an access path. If the tailnet join itself fails, recovery is
   Hetzner rescue mode, not this key.

None of these four layers is optional, and none compensates for a
failure in another. Removing any one weakens the justification for the
others. An operator who does not know what this VM exposes, and why,
cannot maintain it safely. Treating any one of these four as something to
"harden later" is a live security regression, not a convenience.

## What has not been verified — read before you rely on this

Nobody has applied this Terraform or run this Ansible against a real VM.
Real Docker containers, real TLS handshakes, and real fault injection
were used extensively during development. But several things can only get their first
real exercise on an actual apply, and you should know which before
relying on them:

- **Real ACME issuance, and the roughly day-60 renewal against Let's
  Encrypt for `db.announce.aztec.network`.** The cert-reload hook's own
  logic (detecting a changed certificate, copying it into Postgres, and
  confirming Postgres accepted the reload from its own log line, rather
  than assuming) was proven against a seeded stand-in certificate placed
  to simulate what a real renewal produces. It was not proven against an
  actual Caddy renewal event. DNS reachability, challenge completion, and
  Let's Encrypt's own rate limits are all unexercised.
- **The client-side trust chain (Netlify to Postgres over
  `verify-full`) has never been verified against a real Let's Encrypt
  certificate.** Every local proof that TLS verification works used
  `infra/dev/gen-test-certs.sh`, which generates a single self-signed
  certificate and points both the server and `DATABASE_SSL_ROOT_CERT` at
  it. By construction, the client's trusted CA and the server's own
  certificate are the same file. That is not the topology this
  deployment actually has. With Let's Encrypt, the server presents a leaf
  certificate, and the client must trust the issuer (ISRG Root X1): two
  different certificates. Nothing in this repository's test suite or local
  proofs exercises that two-certificate chain. The `openssl s_client
  -starttls postgres` command in step 4 above is the first point where
  this chain gets checked at all, and it has not yet been run against a
  real deployment.
- **The Hetzner firewall's real behaviour.** No Hetzner resources were
  ever created during development. The firewall rules in `vm.tf` were
  validated by `terraform plan`/`validate` against the real Hetzner API,
  not by actual traffic hitting a real, applied firewall.
- **`RequiresMountsFor` under an actual reboot.** The systemd drop-in
  that stops Docker starting Postgres before the data volume is mounted
  was checked with `ansible-lint`/`--syntax-check` only. The boot-race
  scenario it exists to close needs a real reboot, or a rescue-mode
  rebuild of a real Hetzner volume, to observe directly. The development
  sandbox had no systemd and no real boot sequence.
- **`fail2ban-client status <jail>` on a live jail.** The regex was
  proven correct against real captured Postgres log lines from a real
  container: six real failed logins, all six correctly matched and
  IP-extracted. But `fail2ban` itself could not be installed in the
  development sandbox (no root or apt access), so the jail has never
  actually banned a real repeated-failure source IP end to end.
- **A full, non-syntax-check `ansible-playbook` run against a live
  host.** Only `--syntax-check` and `ansible-lint` (clean at the
  `production` profile) were run. There was no real inventory host to
  target. The first real `ansible-playbook -i inventory.yml site.yml` run
  in step 4 above is this playbook's first real execution.
- **The cert-reload hook's 8-second polling window, sized against a
  lightly loaded sandbox.** After a SIGHUP, the script polls Postgres's
  own log for up to 8 seconds to confirm the reload was accepted, not
  just that the file on disk changed (see `cert-reload.sh.j2`'s comments
  on the reload-verification check for why a bare file-hash or
  `pg_stat_ssl` check was proven insufficient). The 8-second ceiling is
  based on a roughly 57ms measured logging-driver flush time in the
  development sandbox, giving roughly two orders of magnitude of
  headroom. That measurement was taken under light load, not real
  production disk or CPU contention. If the ceiling is ever too short
  under real load, the failure mode is a false "UNCONFIRMED — check
  manually" alert, not a silent false success (see the polling logic's
  own comments for the distinct outcomes it reports).
- **The Ansible bootstrap-cert task's "no network dependency" property**
  against a genuine host `openssl` binary on a genuine target host. The
  development sandbox had no root access to a real Docker volume
  mountpoint, so this was proven with a substitute (a throwaway container
  mounting the named volume), not the actual Ansible task path.

What was proven, with real Docker containers: TLS handshakes against both the bootstrap placeholder and injected
certificates; certificate rejection with a wrong CA; the Signal proxy's
fail-closed behavior (missing header, wrong header, unset secret — all
return 403, and `docker compose up` itself refuses to start without
`ANNOUNCE_SIGNAL_SECRET` set); the cert-reload hook firing end-to-end
against a seeded certificate, including its ambiguous-multi-issuer
refusal, incomplete-pair detection, and rejected-SIGHUP detection (a
deliberately mismatched key, confirmed via `openssl s_client` that
Postgres kept serving the old certificate while the naive checks would
have reported success); and the fail2ban filter regex against real
captured Postgres auth-failure log lines.
