# Terraform — the announcement tool's database + Signal host

Creates the Hetzner VM for the split deployment: Postgres (reachable from
Netlify's egress on 5432), signal-cli-rest-api, and a Caddy reverse proxy
(443 — ACME and the Signal proxy). See `vm.tf`, `variables.tf`, and
`outputs.tf` for what and why. See `versions.tf` for the state decision.

**This file covers the Terraform module only.** The deployment procedure,
with every command, is the runbook: [`infra/README.md`](../README.md).

## Apply order

Running steps 2 and 3 out of order produces a certificate failure that
looks like a Terraform bug (see below).

```
1. terraform apply                      -> runbook step 2
2. DNS: point an A record for           -> runbook step 3
   db.announce.aztec.network at the IPv4
   printed by the `announce_server_ipv4` output
3. Ansible: installs Postgres,          -> runbook step 4
   signal-cli-rest-api and Caddy
4. alter role announce_app with         -> runbook step 5, and
   login password '...'                    "Deploying: setting
                                            the real password"
5. Verify the application connects      -> runbook step 7
   with sslmode=verify-full
```

This list is a summary. It numbers the Terraform-facing steps only, and it
does not give the commands. The full procedure, with every command and the
reason for each, is the runbook: [`infra/README.md`](../README.md). The
arrows above map each line to its runbook step, because the two documents
number them differently.

Warning: port 5432 is not safe to treat as live until all five steps are done.
Terraform's `apply` only creates the host and opens the firewall. It does
not install Postgres, does not create the `announce_app` role's password,
and does not configure TLS. Between step 1 and step 4, 5432 is a public,
listening port. Before Ansible runs, nothing is behind that port yet.
After Ansible runs, the `announce_app` role exists but stays `NOLOGIN`
until step 4 is done by hand (see [`infra/README.md`](../README.md) for why this is
deliberate: a committed placeholder password would be worse). Do not
point the application's `DATABASE_URL` at this host until step 5 has
actually been checked, not assumed.

### Why step 2 must happen before step 3

Caddy performs the ACME challenge for `db.announce.aztec.network` as part of
its first run. If Ansible (step 3) runs before the DNS A record (step 2)
has propagated, Caddy cannot complete the challenge, and certificate
issuance fails. That failure surfaces as an Ansible or Caddy error, and
it looks like something broke in the playbook or the Terraform. It did
not: the domain simply did not resolve to this host yet. Set the DNS
record first, and give it time to propagate before running Ansible, not
just before checking the site in a browser afterward.

## Tearing down

`hcloud_volume.announce_data` has `prevent_destroy = true` (see the
comment in `vm.tf`). This blocks `terraform destroy` entirely, not only
for that resource. Terraform refuses the whole plan with "Resource has
lifecycle.prevent_destroy set". To actually destroy the deployment,
including the server, either remove that lifecycle block first, or run
`terraform state rm hcloud_volume.announce_data` and then destroy the
rest. That command only stops Terraform from tracking the volume; it does
not delete the volume.

## Verification performed on this module

No VM has been created from this configuration yet. The first `terraform
apply` is its first real test.
