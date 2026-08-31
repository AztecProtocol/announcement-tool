# The announcement tool's database + Signal host.
#
# One Hetzner VM runs Postgres (the app's database, reachable from Netlify's
# egress pool on 5432) plus signal-cli-rest-api and a Caddy reverse proxy
# (443 — ACME challenge + the Signal proxy) in Docker, deployed
# by Ansible after Terraform creates the host. cloud-init here does nothing
# but prepare the host for Ansible — no tailnet join, unlike
# aztec-observability, because there is no tailnet on this deployment
# (decided 2026-08-27, see variables.tf `operator_ssh_cidrs`).
#
# Sizing: see the `server_type` and `data_volume_size_gb` variable
# descriptions in variables.tf for the justification. In short, this is a
# low-volume application database plus two small containers, not a TSDB, so
# it is sized far below the aztec-observability sibling module's ccx23/512GB.

provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_ssh_key" "announce" {
  name       = "aztec-announce"
  public_key = var.ssh_public_key
}

resource "hcloud_server" "announce" {
  name         = "aztec-announce-${var.hcloud_location}"
  server_type  = var.server_type
  image        = var.image
  location     = var.hcloud_location
  ssh_keys     = [hcloud_ssh_key.announce.id]
  firewall_ids = [hcloud_firewall.announce.id]

  labels = {
    role    = "announce"
    service = "announce-aztec-network"
  }

  user_data = templatefile("${path.module}/cloud-init/announce.yaml.tftpl", {
    hostname = "aztec-announce-${var.hcloud_location}"
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

# No tailnet on this deployment (decided 2026-08-27). Public TCP ports are
# the actual access path, not a firewall-blocked fallback behind a private
# network. Every rule here is a deliberate choice, not a default left in place:
#   443/tcp  — Caddy: ACME HTTP-01/TLS-ALPN challenge for announce.aztec.network,
#              and the reverse-proxy path to signal-cli-rest-api.
#   5432/tcp — Postgres, reachable directly from Netlify's egress. Netlify
#              functions egress from a shifting pool of 80+ IPs with no
#              stable range to allowlist, so an IP allowlist here is not a
#              workable alternative to opening the port; connection auth
#              (TLS + the least-privilege announce_app role, see
#              infra/README.md) is the real control.
#   22/tcp   — restricted to var.operator_ssh_cidrs (required, no default —
#              see that variable). Without a tailnet there is no
#              `tailscale ssh`; this is Ansible's and any operator's only
#              way in, so it must be explicit, not 0.0.0.0/0.
#   icmp     — diagnostic ping, harmless to leave open.
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
    protocol   = "tcp"
    port       = "22"
    source_ips = var.operator_ssh_cidrs
  }

  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# Render the Ansible inventory from Terraform outputs, mirroring
# aztec-observability's inventory.tf pattern — but addressed by the server's
# public IPv4, not a tailnet MagicDNS name, since there is no tailnet here.
resource "local_file" "ansible_inventory" {
  filename        = "${path.module}/ansible/inventory.yml"
  file_permission = "0644"

  content = templatefile("${path.module}/ansible/inventory.yml.tftpl", {
    announce_host_ip = hcloud_server.announce.ipv4_address
    data_volume_id   = hcloud_volume.announce_data.id
  })

  # Not a data dependency, but a real one: the volume must be attached (and
  # therefore mounted at a known path) before Ansible has anything to point
  # RequiresMountsFor at, or a Postgres deploy race.
  depends_on = [hcloud_volume_attachment.announce_data]
}
