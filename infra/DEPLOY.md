# Deploy the announcement tool

Follow these steps in order. Each step has the commands to run and a check
that it worked. Do not skip a check.

This guide gives the commands only. For the reasons behind them, and for the
security posture of this deployment, read [`README.md`](README.md) in this
directory.

**What you are building.** The app and worker run on Netlify. This procedure
creates one Hetzner VM that runs Postgres, a Signal sidecar, and Caddy. The two
hosts have different names: Netlify serves `announce.aztec.network`, and the VM
answers on `db.announce.aztec.network`.

**Time:** about 30 minutes, plus DNS propagation.

---

## Before you start

You need all six of these. Collect them first.

| What | Notes |
|---|---|
| A Hetzner Cloud API token | For the project the VM will live in. |
| AWS credentials for `aztec-foundation-terraform-state` | `eu-west-2`. Terraform stores its state there. `terraform init` fails without them. |
| A Tailscale API key (or OAuth client secret) | `var.tailscale_api_key` (`TF_VAR_tailscale_api_key`). Authenticates Terraform to `api.tailscale.com` so it can mint this VM's tailnet auth key. Without it, `terraform apply` fails creating `tailscale_tailnet_key.announce` with an authentication error — see the troubleshooting table below, and do not confuse this with the separate ACL-tag failure covered there. |
| An SSH public key | Must be different key material from any other Hetzner module in the same project. Hetzner rejects a duplicate fingerprint and the apply fails. Break-glass only — see "The tailnet ACL tag" warning below for the normal access path, and "If something failed" for what break-glass actually means on this VM. |
| The tailnet this VM joins, and the `tag:announce` ACL tag | `var.tailnet` and `var.tailscale_acl_tag`. Warning: `tag:announce` must already exist in that tailnet's ACL before you apply — see below. |
| DNS control for `aztec.network` | You add one A record in step 3. |

Warning: **the `tag:announce` ACL tag must exist before you run `terraform
apply`.** It is not created by this module. It is owned by
`rpc.aztec.foundation/tailscale.tf` in `AztecProtocol/foundation-iac`, a
singleton applied with `overwrite_existing_content = true`. Add the tag
there, in code, and apply that module first. Do not add it by hand in the
Tailscale admin console — the next apply of that module reverts a
console-only edit. **The common case is not an unreachable VM — it is no VM
at all.** `hcloud_server.announce` depends on `tailscale_tailnet_key.announce`,
so if the tag is missing, `terraform apply` fails creating the key and stops
right there; the server is never created, and there is nothing to recover.
The worse case — a VM that boots and only then finds `tailscale up` failing
in cloud-init, leaving it genuinely unreachable — needs the tag to exist at
key-creation time but then be removed, or some other tag/auth-key mismatch,
before the boot. It is possible, just less likely than the plan simply
refusing to create anything.

You also need to be on the tailnet yourself, to reach the VM once it exists.

```sh
tailscale status
```

**Check:** your own machine appears in the output, not an error. If
`tailscale` is not installed, or you are logged into the wrong tailnet,
install it and join the same tailnet as `var.tailnet` before continuing.

Install `terraform`, `ansible`, `psql`, `dig` and `openssl` on the machine you
are working from. Also install this repo's own Node dependencies
(`npm install`) — steps 6 and 7 run `npm run migrate` and
`npm run seed:publisher` from here, not on the VM. The VM has no Node
runtime and no `npm`.

---

## Step 1 — Create the VM

Terraform asks for the values from the table above, or reads them from a
`terraform.tfvars` you create from `terraform.tfvars.example`:

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Fill in real values in `terraform.tfvars`, or export `TF_VAR_hcloud_token`
and `TF_VAR_tailscale_api_key` instead of putting either secret in the file —
the example file prefers this, if your shell setup allows it.
`tailscale_api_key` has no default either: without it, Terraform authenticates
to `api.tailscale.com` with whatever ambient credential (if any) is lying
around the shell, which can silently mint the tailnet key in the wrong
tailnet rather than failing — see `variables.tf`. `tailnet` and
`tailscale_acl_tag` also have no default: Terraform refuses to plan without
`tailnet` set, and applying with the wrong `tailscale_acl_tag` (or before
that tag exists — see "Before you start") fails creating the tailnet key,
which in turn means `terraform apply` stops there and the server itself is
never created.

```sh
terraform init
terraform apply
```

**Check:** the apply prints the VM's public address and its tailnet name.
Write both down. Step 2 needs the address, step 3 and step 4 need the name.

```
announce_server_ipv4 = "203.0.113.42"
announce_server_name = "aztec-announce-fsn1"
domain               = "db.announce.aztec.network"
```

To read either again later, from any machine with state access:

```sh
terraform output announce_server_ipv4
terraform output announce_server_name
```

---

## Step 2 — Add the DNS record

Point an A record for `db.announce.aztec.network` at the address from step 1,
in whatever system controls the `aztec.network` nameservers.

This record is for the VM only. It does not change where
`announce.aztec.network` points, and it does not affect the public site.

**Check:** the name must resolve to your VM before you continue.

```sh
dig +short db.announce.aztec.network
```

The output must be the address from step 1. If it is empty or different, wait
and run it again. Do not continue until it matches.

Warning: step 3 fails if you continue before this resolves. Caddy requests its
TLS certificate during step 3, and the certificate authority checks this DNS
record. The failure appears inside Ansible and looks like a broken playbook. It
is not: the name simply does not point at the VM yet.

---

## Step 3 — Create the secrets file on the VM

Ansible does not create this file. It holds real secrets, so you write it by
hand, once.

Warning: `ANNOUNCE_DOMAIN` must match Terraform's `domain` value exactly. If
you did not override `domain` in `terraform.tfvars`, the value below is
already correct.

```sh
tailscale ssh root@<name from step 1>
mkdir -p /opt/announce
cat > /opt/announce/.env <<'EOF'
POSTGRES_PASSWORD=
ANNOUNCE_DOMAIN=db.announce.aztec.network
ANNOUNCE_SIGNAL_SECRET=
SIGNAL_ACCOUNT=
BACKUP_ENCRYPTION_KEY=
BACKUP_S3_BUCKET=
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=
EOF
chmod 600 /opt/announce/.env
```

This file holds every secret in the deployment.

Generate each secret with:

```sh
openssl rand -base64 32
```

Two rules for this file:

- Quote any value that contains a space.
- Keep `ANNOUNCE_SIGNAL_SECRET`. You set the same value in Netlify at step 8.

**Which values you may leave empty on a first deployment, and what happens
if you do:**

| Variable | May be left empty? | If empty |
|---|---|---|
| `POSTGRES_PASSWORD` | No | The stack will not start at all. |
| `ANNOUNCE_DOMAIN` | No | The stack will not start at all. |
| `ANNOUNCE_SIGNAL_SECRET` | No | The stack will not start at all. |
| `BACKUP_ENCRYPTION_KEY` | No | The stack will not start at all. Backups must never run unencrypted, so this fails closed rather than degrading. |
| `SIGNAL_ACCOUNT` | Yes | Everything starts except `signal-receive`, which restarts in a loop until a Signal number is registered. |
| `BACKUP_S3_BUCKET` | Yes | Everything starts except `backup`, which restarts in a loop until an S3 destination is configured. `db`, `signal` and `caddy` are unaffected — your data is safe, it is just not being copied off-host yet. |
| `BACKUP_S3_ACCESS_KEY_ID` | Yes | Same as `BACKUP_S3_BUCKET` — leave all three S3 variables empty together, or fill in all three together. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Yes | Same as `BACKUP_S3_BUCKET`. |

Fill in every value marked "No" above before continuing — the check at the
end of step 4 will not pass otherwise. The four marked "Yes" can stay empty
for now and be filled in later, once a Signal number is registered or an S3
bucket exists; there is no need to re-run Ansible for that, only to update
this file and restart the affected container (`docker compose up -d
signal-receive` or `docker compose up -d backup`).

`SIGNAL_ACCOUNT` is a registered Signal phone number, for example
`+15551234567`. Signal is not in use yet, so leave it empty for now: write
`SIGNAL_ACCOUNT=` with no value, not a placeholder string.

**Check:**

```sh
stat -c "%a %n" /opt/announce/.env
grep -c '=$' /opt/announce/.env
```

The first command must print `600 /opt/announce/.env`. Any other mode means
the secrets file is readable by other users on the host.

The second command counts the values still empty. It must print `4`: the
three `BACKUP_S3_*` values and `SIGNAL_ACCOUNT`, which this deployment leaves
empty on purpose. A higher number means a value marked "No" in the table
above is still blank, and step 4 will abort the whole stack.

---

## Step 4 — Install and start the services

`inventory.yml` in this directory is generated by `terraform apply` in
step 1 (see the "Verify" note there). Do not hand-write it: a hand-written
copy of `inventory.yml.example` carries a placeholder `data_mount` path,
and a wrong mount path can send Postgres's data onto the root disk instead
of the data volume.

```sh
cd infra/ansible
ansible-galaxy collection install -r requirements.yml
ansible-playbook -i inventory.yml site.yml
```

This installs Docker, mounts the data volume, starts Postgres, the Signal
sidecar and Caddy, configures `fail2ban`, and installs the certificate-renewal
job.

**Check:**

```sh
tailscale ssh root@<name from step 1> 'docker compose -f /opt/announce/docker-compose.yml ps'
```

`db`, `signal` and `caddy` must all show `Up` or `healthy`. `backup` too,
unless you left the S3 variables empty in step 3, in which case it restarts
in a loop until they are set — expected, see the table in step 3.
`signal-receive` restarts in a loop until a Signal account is registered.
Also expected.

---

## Step 5 — Confirm the certificate is real

Caddy requests a Let's Encrypt certificate during step 4.

```sh
echo | openssl s_client -connect db.announce.aztec.network:443 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

The issuer must name Let's Encrypt. If it names anything else, the certificate
did not issue. Check the DNS record from step 2 first. If the certificate's
subject is `CN=announce-bootstrap-placeholder`, the `cert_reload` role has not
replaced the bootstrap placeholder yet — check
`/var/log/announce-cert-reload.log` on the VM.

Now confirm the database port serves a certificate the app will accept.
Run this from the root of this repo (the directory with `package.json` in
it) — step 6 needs both the repo root and this downloaded certificate, and
downloading it here avoids a second `cd` later.

Run this check from a machine other than the VM. On the VM itself, the
local trust store can make a broken chain look fine.

```sh
cd <path to your checkout of this repo>
curl -o isrgrootx1.pem https://letsencrypt.org/certs/isrgrootx1.pem
openssl s_client -connect db.announce.aztec.network:5432 -starttls postgres \
  -CAfile isrgrootx1.pem -verify_return_error \
  -verify_hostname db.announce.aztec.network </dev/null
```

**Check:** the output must contain `Verify return code: 0 (ok)`. Anything else
means the app cannot connect. Do not continue.

---

## Step 6 — Set up the database

Run these from your own machine (the one with this repo checked out and
`npm install` already run — see "Before you start"), not on the VM. There is
no Node runtime there. Stay in the repo root — the same directory as step 5,
with both `package.json` and `isrgrootx1.pem` in it. Both commands below go
over the internet to `db.announce.aztec.network:5432`, so both must use
verified TLS.

Warning: do not drop `DATABASE_SSL_MODE`/`DATABASE_SSL_ROOT_CERT` (for the
`npm run` commands) or `PGSSLMODE`/`PGSSLROOTCERT` (for `psql`) to "simplify"
this. Without them the database owner's password — the most powerful
credential in this system — crosses the internet unverified, or in plain
text, and `src/db/connect.ts` fails open on a missing value rather than
refusing to run: forgetting one of these variables produces no error, only
a silent unverified connection.

Set both once, so there is one place to get this right instead of four:

```sh
export DATABASE_SSL_MODE=verify-full DATABASE_SSL_ROOT_CERT="$PWD/isrgrootx1.pem"
```

```sh
DATABASE_URL='postgres://announce:<POSTGRES_PASSWORD from step 3>@db.announce.aztec.network:5432/announce' \
  npm run migrate
```

Warning: do not put `sslmode` or `sslrootcert` in `DATABASE_URL` itself. This
command goes through the same connection code as the app
(`src/db/connect.ts`), and it refuses to start if either appears there — use
the two `DATABASE_SSL_*` variables exported above instead. See step 8's table
for why.

Then give the application's database role a password. It cannot log in until
you do. This prints the password once — capture it now, you need it in
step 8:

```sh
APP_PW="$(openssl rand -base64 32)"
PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/isrgrootx1.pem" \
  psql "postgres://announce:<POSTGRES_PASSWORD from step 3>@db.announce.aztec.network:5432/announce" \
  -c "alter role announce_app with login password '$APP_PW';"
printf 'announce_app password: %s\n' "$APP_PW"
```

**Check:**

```sh
PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/isrgrootx1.pem" \
  psql "postgres://announce:<POSTGRES_PASSWORD from step 3>@db.announce.aztec.network:5432/announce" \
  -c "select rolcanlogin from pg_roles where rolname = 'announce_app';" \
  -c "select ssl from pg_stat_ssl where pid = pg_backend_pid();"
```

The first result must be `t`. If it is `f`, the `alter role` command did not
run.

The second result must also be `t`. It reports whether this connection used
TLS. If it is `f`, the commands above ran over plain text, and the owner
password crossed the internet unprotected. Check that `PGSSLMODE` and
`PGSSLROOTCERT` are set, then change both passwords.

This puts the generated password in your shell history, in `$APP_PW`, and in
the printed output above. Copy it into Netlify's environment variables (step
8) now, then clear your history (`history -d`, or your shell's equivalent).
If you lose it anyway, re-run the `alter role` command with a new password —
nothing else in this system depends on the old value.

---

## Step 7 — Add the first publisher

The app refuses to start until at least one publisher exists. Run this from
the same machine, same directory, and same session as step 6 — the
`DATABASE_SSL_MODE`/`DATABASE_SSL_ROOT_CERT` you exported there are still in
effect.

```sh
DATABASE_URL='postgres://announce:<POSTGRES_PASSWORD from step 3>@db.announce.aztec.network:5432/announce' \
  npm run seed:publisher -- you@example.com
```

Use the email address you sign in to the admin surface with.

Publishing a critical announcement needs two different publishers. Add the
second one the same way.

**Check:** the command itself prints the current publisher list after
inserting. Confirm the email you passed appears in it.

---

## Step 8 — Point Netlify at the VM

Set these in the Netlify site's environment variables. Do not put them in this
repository.

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgres://announce_app:<password from step 6>@db.announce.aztec.network:5432/announce` |
| `DATABASE_SSL_MODE` | `verify-full` |
| `DATABASE_SSL_ROOT_CERT` | The full text of `isrgrootx1.pem` from step 5. Paste the certificate itself, not a file path. |
| `SIGNAL_API_BASE` | `https://db.announce.aztec.network` |
| `SIGNAL_API_SECRET` | The same value as `ANNOUNCE_SIGNAL_SECRET` in step 3. |
| `ENABLED_CHANNELS` | `webhook,discord,telegram,email` |
| `DEPLOY_TARGET` | `netlify` |

Four rules that cause silent failures if broken:

- Do not put `sslmode` or `sslrootcert` in `DATABASE_URL`. The app refuses to
  start if either is present.
- `DATABASE_SSL_ROOT_CERT` is the Let's Encrypt root certificate from step 5.
  It is not the VM's own certificate, and not anything from Caddy's storage.
- `ENABLED_CHANNELS` must not contain `signal` until a Signal number is
  registered. The app refuses to start otherwise.
- `openssl rand -base64 32` can emit `/` and `+` in its output. Both must be
  percent-encoded if you place this password into a `DATABASE_URL`'s
  userinfo section. An unencoded `/` or `+` there produces an opaque
  connection-string parse error, not a clear "bad character" message.

Netlify also needs the Auth0 and session variables. The root
[`README.md`](../README.md) Configuration table lists them.

**Check:** deploy, then confirm the Netlify logs show no startup failure, and
that the admin page signs you in rather than showing "Admin is unavailable".

---

## You are done

The database, the Signal sidecar and Caddy run on the VM. The app and worker
run on Netlify and connect over verified TLS.

**Before announcing anything to real subscribers,** authenticate the sending
domain. Add SPF, DKIM and DMARC records for the address the tool sends from.
Without them, announcements arrive in recipients' spam folders. This has
already happened once during testing, and it looked like a broken tool rather
than a DNS problem.

## If something failed

| Symptom | Likely cause |
|---|---|
| `terraform init` fails | AWS credentials for the state bucket are missing. |
| Terraform refuses to plan | `tailnet` is not set. It has no default. |
| `terraform apply` fails creating `tailscale_tailnet_key.announce` with an authentication error (401, "unauthorized", or similar) | `tailscale_api_key` is missing, wrong, or expired — not the ACL tag. Check `TF_VAR_tailscale_api_key` is actually set in the shell that ran `terraform apply`. This is the more common of the two `tailscale_tailnet_key.announce` failures; check this first before assuming the ACL tag is the problem. |
| `terraform apply` fails creating `tailscale_tailnet_key.announce` with an unknown-tag or "requested tags are invalid" error | `tag:announce` does not exist yet in the tailnet's ACL. It must be added in `rpc.aztec.foundation/tailscale.tf` (`AztecProtocol/foundation-iac`) and that module applied first — see "Before you start". A console-only edit does not survive that module's next apply. In both this row and the credential row above, the server is never created — `hcloud_server.announce` depends on the key resource, so the apply stops before Hetzner is touched at all. |
| The VM boots (the apply succeeded) but it never appears in `tailscale status`, or appears but stays `Offline`/unreachable | Rarer than the two rows above, because it means the key itself was minted successfully. Check `cloud-init` logs on the VM (via Hetzner rescue mode — see the next row) for the `tailscale up` line's own error. If the tailnet has device approval enabled and something changed `preauthorized` away from `true` on the key, the node joins in a PENDING state and needs approving by hand in the Tailscale admin console before it is routable — indistinguishable from a broken join until you check there. |
| `tailscale ssh root@<name>` hangs, no response, or the name is not found | You are not on the same tailnet as `var.tailnet` — check with `tailscale status`. Or the VM's tailnet join itself failed; the SSH key from "Before you start" does not help here — the Hetzner web console is a keyboard-and-screen session at a boot prompt, not an SSH endpoint, and a stock image has no root password set. Use Hetzner **rescue mode** instead: boot the rescue system from the Hetzner console, mount the VM's root disk, and inspect `cloud-init` / Tailscale logs or set a password from inside the mounted filesystem, then reboot normally. |
| Ansible fails on "environment file exists" | Step 3 was skipped. |
| Certificate is not from Let's Encrypt | The DNS record from step 2 had not propagated when step 4 ran. Fix the record, then run step 4 again. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | `DATABASE_SSL_ROOT_CERT` holds the wrong certificate. It must be the Let's Encrypt root from step 5. |
| The app cannot log in to the database | Step 6's `alter role` did not run. The check returns `f`. |
| `DATABASE_URL` gives an opaque connection-string parse error | The password has an unencoded `/` or `+` in it. Percent-encode both in the userinfo section. |
| The app refuses to start | A required variable is missing. The startup message names it. |

## What has not been tested

This procedure has never run against a real VM. Several parts get their first
real use on your deployment: the certificate request, the certificate renewal
about 60 days later, the firewall, and the `fail2ban` rules.
[`README.md`](README.md) lists all of them, with what was tested and how.
