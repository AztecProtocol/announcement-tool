# The announcement tool's database + Signal host.
#
# One Hetzner VM runs Postgres (the app's database, reachable from Netlify's
# egress pool on 5432) plus signal-cli-rest-api and a Caddy reverse proxy
# (443 — ACME challenge + the Signal proxy) in Docker, deployed
# by Ansible after Terraform creates the host. cloud-init joins the tailnet
# on first boot, following the rpc.aztec.foundation Hetzner idiom the
# aztec-observability sibling module also follows (decided 2026-08-31,
# replacing the operator_ssh_cidrs-gated port-22 approach from 2026-08-27):
# day-2 operator access is `tailscale ssh`, not a public SSH port. This does
# NOT touch 443 or 5432 — those stay open to 0.0.0.0/0 and ::/0 because
# Netlify's serverless functions reach Postgres and the Signal proxy from a
# shifting IP pool that cannot join a tailnet (see the firewall comment
# below and variables.tf `tailnet`/`tailscale_acl_tag`).
#
# Sizing: see the `server_type` and `data_volume_size_gb` variable
# descriptions in variables.tf for the justification. In short, this is a
# low-volume application database plus two small containers, not a TSDB, so
# it is sized far below the aztec-observability sibling module's ccx23/512GB.

provider "hcloud" {
  token = var.hcloud_token
}

# Explicit, not implicit. The tailscale provider accepts every one of these
# arguments as optional and falls back to the TAILSCALE_API_KEY/
# TAILSCALE_OAUTH_CLIENT_ID/TAILSCALE_OAUTH_CLIENT_SECRET env vars, or to
# whatever tailnet owns the ambient credential, if this block is omitted or
# left blank. That default is exactly what var.tailscale_api_key's
# description warns against: a credential that happens to be exported for a
# different tailnet (plausible for anyone who also administers the
# aztec-observability tailnet) would silently mint this key in the wrong
# organization. Wiring both `api_key` and `tailnet` here from named
# variables makes the plan fail loudly instead — an unset
# var.tailscale_api_key stops the plan (see that variable's "no default"),
# rather than quietly succeeding against whichever tailnet an ambient
# credential happens to belong to.
provider "tailscale" {
  api_key = var.tailscale_api_key
  tailnet = var.tailnet
}

# Created only when var.ssh_public_key is set. The key is not an access path
# (see the variable's description): day-2 access is `tailscale ssh`, and
# recovery is Hetzner rescue mode. Making it optional means an operator is not
# required to generate and de-duplicate key material for a path nothing uses.
resource "hcloud_ssh_key" "announce" {
  count      = var.ssh_public_key == null ? 0 : 1
  name       = "aztec-announce"
  public_key = var.ssh_public_key
}

# PREREQUISITE (owner-decided, cross-repo): `tag:announce` (var.tailscale_acl_tag)
# must already exist in the tailnet ACL before this applies. That ACL is a
# singleton owned by rpc.aztec.foundation/tailscale.tf in
# AztecProtocol/foundation-iac, which applies with
# overwrite_existing_content = true — add the tag there, in code, and apply
# that module first. A console-only edit does not survive its next apply.
# See the full failure mode in variables.tf `tailscale_acl_tag`.
#
# ⚠️ SECRET IN STATE: this key's plaintext value is stored in Terraform
# state (see versions.tf and infra/README.md's "Prerequisites" section, both
# of which now flag that the state bucket holds credential-bearing
# material, not just outputs). Reusable + pre-authorized + tagged mirrors
# the aztec-observability sibling's key exactly, for the same reason: a
# one-shot ephemeral key would force a manual re-auth step on every rebuild.
resource "tailscale_tailnet_key" "announce" {
  reusable      = true
  ephemeral     = false
  preauthorized = true
  tags          = [var.tailscale_acl_tag]
  description   = "aztec-announce vm bootstrap"
}

# The VM's public IPv4, reserved separately from the server so a rebuild
# keeps it. Without this, Hetzner assigns an address at server creation and
# releases it at deletion, and every rebuild (`terraform apply
# -replace=hcloud_server.announce`) changes the address behind the
# db.announce.aztec.network A record in AztecProtocol/foundation-iac, which
# then needs a PR and an apply before Caddy can renew and Netlify can
# connect. Reserving it makes the DNS record a one-time step.
#
# auto_delete = false: the address must outlive any server it is attached
# to. The provider documents auto_delete = true as a way to break state.
#
# prevent_destroy: same reasoning as the data volume below. Losing this
# address is a DNS change plus a Caddy re-issue, not a data loss, but it is
# the one piece of infrastructure the foundation-iac repository hardcodes,
# so it is protected the same way. A deliberate teardown removes this block
# first, or untracks the resource with `terraform state rm`.
#
# No assignee_type/assignee_id: the provider (~> 1.68 installed here) only
# needs those together, for assigning an already-existing primary IP to a
# resource out-of-band. The server below claims this IP through its own
# public_net.ipv4 argument instead, which is the provider's documented
# pattern for a primary IP created alongside its server.
resource "hcloud_primary_ip" "announce" {
  name        = "aztec-announce-ipv4"
  type        = "ipv4"
  location    = var.hcloud_location
  auto_delete = false

  labels = {
    role    = "announce"
    service = "announce-aztec-network"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_server" "announce" {
  name         = "aztec-announce-${var.hcloud_location}"
  server_type  = var.server_type
  image        = var.image
  location     = var.hcloud_location
  ssh_keys     = hcloud_ssh_key.announce[*].id
  firewall_ids = [hcloud_firewall.announce.id]

  # ipv4 is the reserved address above. ipv6_enabled stays true: Hetzner
  # still allocates a server-scoped IPv6 that dies with the server; nothing
  # depends on it (the A record and Caddy use IPv4 only).
  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.announce.id
    ipv6_enabled = true
  }

  labels = {
    role    = "announce"
    service = "announce-aztec-network"
  }

  user_data = templatefile("${path.module}/cloud-init/announce.yaml.tftpl", {
    hostname           = "aztec-announce-${var.hcloud_location}"
    tailscale_auth_key = tailscale_tailnet_key.announce.key
  })

  lifecycle {
    # Cloud-init only runs on first boot; day-2 changes happen via Ansible.
    ignore_changes = [
      user_data,
      ssh_keys,
      image,
    ]
  }
}

# Postgres data (and nightly backup archives) live on a volume, not the root
# disk: it grows without downtime (terraform resize + a manual `xfs_growfs`
# on the host — Terraform cannot do the filesystem step), survives a server
# rebuild, and is detachable if the stack ever moves hosts.
#
# Boot-ordering note for Ansible: Docker must not start Postgres's
# container before this volume is mounted, or the container writes its data
# directory to the root disk and the later volume mount shadows it. Fix that
# with a systemd drop-in (`RequiresMountsFor=<mount path>` on docker.service
# or the compose unit) — same pattern the aztec-observability module uses.
resource "hcloud_volume" "announce_data" {
  name     = "aztec-announce-data"
  size     = var.data_volume_size_gb
  location = var.hcloud_location
  format   = "xfs"

  lifecycle {
    # The database (announcements, subscribers, delivery ledger, audit log)
    # is the expensive thing to lose. Note for whoever runs `terraform
    # destroy`: this blocks the entire destroy plan, not just this resource.
    # Terraform refuses all-or-nothing with "Resource has
    # lifecycle.prevent_destroy set". To actually tear down (including the
    # server), either remove this block first, or run
    # `terraform state rm hcloud_volume.announce_data` to stop tracking the
    # volume (it is not deleted by that command, only untracked), then
    # destroy the rest.
    prevent_destroy = true
  }
}

resource "hcloud_volume_attachment" "announce_data" {
  volume_id = hcloud_volume.announce_data.id
  server_id = hcloud_server.announce.id
  automount = true
}

# Operator access moved onto the tailnet (decided 2026-08-31); the VM's
# public surface is now only what Netlify's functions actually need. Every
# rule here is a deliberate choice, not a default left in place:
#   443/tcp  — Caddy: ACME HTTP-01/TLS-ALPN challenge for db.announce.aztec.network,
#              and the reverse-proxy path to signal-cli-rest-api. UNCHANGED —
#              Netlify's functions cannot join a tailnet, so this must stay
#              open to 0.0.0.0/0 and ::/0. Do not restrict this rule.
#   5432/tcp — Postgres, reachable directly from Netlify's egress. Netlify
#              functions egress from a shifting pool of 80+ IPs with no
#              stable range to allowlist, so an IP allowlist here is not a
#              workable alternative to opening the port; connection auth
#              (TLS + the least-privilege announce_app role, see
#              infra/README.md) is the real control. UNCHANGED — same
#              cannot-join-a-tailnet constraint as 443. Do not restrict this
#              rule either.
#   41641/udp — Tailscale's direct-path port (see var.tailnet /
#              var.tailscale_acl_tag). Left open to 0.0.0.0/0 and ::/0, same
#              as the aztec-observability sibling: this is how two tailnet
#              peers negotiate a direct connection, not a general listener.
#              If this path is blocked, Tailscale still connects — falls
#              back to relaying over DERP — so this rule is an optimization,
#              not the tailnet's only path in.
#   icmp     — diagnostic ping, harmless to leave open.
#
# Port 22 is gone. There is no `operator_ssh_cidrs` rule to keep in sync
# with a CIDR list anymore; day-2 operator access is `tailscale ssh`, which
# needs no inbound firewall rule of its own (it rides the UDP path above,
# or DERP relay if that is blocked). See variables.tf `ssh_public_key` for
# the one path that still exists outside the tailnet: the Hetzner web
# console, for when the tailnet join itself is the thing that's broken.
resource "hcloud_firewall" "announce" {
  name = "aztec-announce"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "5432"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "41641"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# Render the Ansible inventory from Terraform outputs, mirroring
# aztec-observability's inventory.tf pattern: addressed by the server's
# tailnet MagicDNS name (its Hetzner server name, matching the
# `tailscale up --hostname=` value in cloud-init/announce.yaml.tftpl), not
# its public IPv4 — port 22 is closed, so the inventory must reach the host
# the same way an operator does.
resource "local_file" "ansible_inventory" {
  # path.module is infra/terraform (this file's own directory — see the
  # templatefile() call below, which resolves ansible/inventory.yml.tftpl
  # from that same base). The playbook runs from infra/ansible, so the
  # rendered file must land one directory up and over from path.module,
  # not under it.
  filename        = "${path.module}/../ansible/inventory.yml"
  file_permission = "0644"

  content = templatefile("${path.module}/ansible/inventory.yml.tftpl", {
    announce_host_name = hcloud_server.announce.name
    data_volume_id     = hcloud_volume.announce_data.id
  })

  # Not a data dependency, but a real one: the volume must be attached (and
  # therefore mounted at a known path) before Ansible has anything to point
  # RequiresMountsFor at, or a Postgres deploy race.
  depends_on = [hcloud_volume_attachment.announce_data]
}
