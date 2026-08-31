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

You need all five of these. Collect them first.

| What | Notes |
|---|---|
| A Hetzner Cloud API token | For the project the VM will live in. |
| AWS credentials for `aztec-foundation-terraform-state` | `eu-west-2`. Terraform stores its state there. `terraform init` fails without them. |
| An SSH public key | Must be different key material from any other Hetzner module in the same project. Hetzner rejects a duplicate fingerprint and the apply fails. |
| The CIDRs allowed to reach port 22 | No default, on purpose. Terraform refuses to plan without it. Never set `0.0.0.0/0`. |
| DNS control for `aztec.network` | You add one A record in step 3. |

Install `terraform`, `ansible`, `psql`, `dig` and `openssl` on the machine you
are working from.

---

## Step 1 — Create the VM

```sh
cd infra/terraform
terraform init
terraform apply
```

Terraform asks for the values from the table above, or reads them from a
`terraform.tfvars` you create from `terraform.tfvars.example`.

**Check:** the apply prints the VM's address. Write it down.

```
announce_server_ipv4 = "203.0.113.42"
domain               = "db.announce.aztec.network"
```

To read it again later, from any machine with state access:

```sh
terraform output announce_server_ipv4
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

```sh
ssh root@<address from step 1>
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
```

Fill in every empty value. Generate each secret with:

```sh
openssl rand -base64 32
```

Two rules for this file:

- Quote any value that contains a space.
- Keep `ANNOUNCE_SIGNAL_SECRET`. You set the same value in Netlify at step 8.

`SIGNAL_ACCOUNT` is a registered Signal phone number, for example
`+15551234567`. Signal is not in use yet, so leave it empty for now: write
`SIGNAL_ACCOUNT=` with no value, not a placeholder string.

Leaving it empty is safe. Only the `signal-receive` container reads this
variable, and only that container restarts until an account exists — `db`,
`signal`, `caddy` and `backup` start normally regardless. That is expected
and confirmed by testing the stack directly with `SIGNAL_ACCOUNT` empty.

**Check:**

```sh
test -f /opt/announce/.env && echo "present"
```

---

## Step 4 — Install and start the services

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
ssh root@<address> 'docker compose -f /opt/announce/docker-compose.yml ps'
```

`db`, `signal`, `caddy` and `backup` must all show `Up` or `healthy`.
`signal-receive` restarts in a loop until a Signal account is registered. That
is expected.

---

## Step 5 — Confirm the certificate is real

Caddy requests a Let's Encrypt certificate during step 4.

```sh
echo | openssl s_client -connect db.announce.aztec.network:443 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

The issuer must name Let's Encrypt. If it names anything else, the certificate
did not issue. Check the DNS record from step 2 first.

Now confirm the database port serves a certificate the app will accept:

```sh
curl -o isrgrootx1.pem https://letsencrypt.org/certs/isrgrootx1.pem
openssl s_client -connect db.announce.aztec.network:5432 -starttls postgres \
  -CAfile isrgrootx1.pem -verify_return_error \
  -verify_hostname db.announce.aztec.network </dev/null
```

**Check:** the output must contain `Verify return code: 0 (ok)`. Anything else
means the app cannot connect. Do not continue.

Run this check from a machine other than the VM.

---

## Step 6 — Set up the database

Run these on the VM, against `127.0.0.1`.

Warning: run these on the VM. Run them from anywhere else and the database
owner's password crosses the internet in plain text.

```sh
ssh root@<address>
cd /opt/announce
DATABASE_URL='postgres://announce:<POSTGRES_PASSWORD from step 3>@127.0.0.1:5432/announce' npm run migrate
```

Then give the application's database role a password. It cannot log in until
you do. Save the generated password: you need it in step 8.

```sh
psql "postgres://announce:<POSTGRES_PASSWORD from step 3>@127.0.0.1:5432/announce" \
  -c "alter role announce_app with login password '$(openssl rand -base64 32)';"
```

**Check:**

```sh
psql "postgres://announce:<POSTGRES_PASSWORD from step 3>@127.0.0.1:5432/announce" \
  -c "select rolcanlogin from pg_roles where rolname = 'announce_app';"
```

The result must be `t`. If it is `f`, the `alter role` command did not run.

---

## Step 7 — Add the first publisher

The app refuses to start until at least one publisher exists.

```sh
ssh root@<address>
cd /opt/announce
DATABASE_URL='postgres://announce:<POSTGRES_PASSWORD from step 3>@127.0.0.1:5432/announce' \
  npm run seed:publisher -- you@example.com
```

Use the email address you sign in to the admin surface with.

Publishing a critical announcement needs two different publishers. Add the
second one the same way.

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

Three rules that cause silent failures if broken:

- Do not put `sslmode` or `sslrootcert` in `DATABASE_URL`. The app refuses to
  start if either is present.
- `DATABASE_SSL_ROOT_CERT` is the Let's Encrypt root certificate from step 5.
  It is not the VM's own certificate, and not anything from Caddy's storage.
- `ENABLED_CHANNELS` must not contain `signal` until a Signal number is
  registered. The app refuses to start otherwise.

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
| Terraform refuses to plan | `operator_ssh_cidrs` is not set. It has no default. |
| Ansible fails on "environment file exists" | Step 3 was skipped. |
| Certificate is not from Let's Encrypt | The DNS record from step 2 had not propagated when step 4 ran. Fix the record, then run step 4 again. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | `DATABASE_SSL_ROOT_CERT` holds the wrong certificate. It must be the Let's Encrypt root from step 5. |
| The app cannot log in to the database | Step 6's `alter role` did not run. The check returns `f`. |
| The app refuses to start | A required variable is missing. The startup message names it. |

## What has not been tested

This procedure has never run against a real VM. Several parts get their first
real use on your deployment: the certificate request, the certificate renewal
about 60 days later, the firewall, and the `fail2ban` rules.
[`README.md`](README.md) lists all of them, with what was tested and how.
