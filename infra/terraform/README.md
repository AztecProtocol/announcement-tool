# Terraform — the announcement tool's database + Signal host

Creates the Hetzner VM for the split deployment: Postgres (reachable from
Netlify's egress on 5432), signal-cli-rest-api, and a Caddy reverse proxy
(443 — ACME + the Signal proxy). See `vm.tf`, `variables.tf`, `outputs.tf`
for what and why; `versions.tf` for the state decision.

## Required order — this is load-bearing, not a suggestion

```
1. terraform apply
2. DNS: point an A record for announce.aztec.network at the IPv4
   printed by the `announce_server_ipv4` output
3. Ansible (Task 6) — installs Postgres, signal-cli-rest-api, Caddy
4. alter role announce_app with login password '...'
   (see ../README.md "Deploying: setting the real password")
5. Verify the application connects with sslmode=verify-full
```

**Port 5432 is not safe to consider "live" until all five steps are done.**
Terraform's `apply` only creates the host and opens the firewall — it does
not install Postgres, does not create the `announce_app` role's password,
and does not configure TLS. Between step 1 and step 4, 5432 is a public,
listening port with no application behind it yet (Ansible hasn't run) and
then, after Ansible, a role that is `NOLOGIN` until step 4 is done by hand
(see `../README.md` for why that's deliberate — a committed placeholder
password would be worse). Do not point the application's `DATABASE_URL` at
this host until step 5 has actually been checked, not assumed.

### Why step 2 has to happen before step 3

Caddy performs the ACME challenge for `announce.aztec.network` as part of
its first run. If Ansible (step 3) runs before the DNS A record (step 2)
has propagated, Caddy cannot complete the challenge and its certificate
issuance fails. That failure surfaces as an Ansible/Caddy error and looks
like something broke in the playbook or the Terraform — it did not; the
domain simply didn't resolve to this host yet. Set the DNS record first and
give it time to propagate before running Ansible, not just before checking
the site in a browser afterward.

## Tearing down

`hcloud_volume.announce_data` has `prevent_destroy = true` (see the comment
in `vm.tf`). This blocks `terraform destroy` entirely, not just for that
resource — Terraform refuses the whole plan with "Resource has
lifecycle.prevent_destroy set". To actually destroy (including the server),
either remove that lifecycle block first, or run
`terraform state rm hcloud_volume.announce_data` (this only stops Terraform
tracking the volume — it does NOT delete it) and then destroy the rest.

## Verification performed on this module

See `../../.superpowers/sdd/2026-08-27-06b-split-infrastructure/task-5-report.md`
for exactly what was and wasn't validated (no VM has ever been applied from
this configuration).
