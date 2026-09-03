output "announce_server_ipv4" {
  value       = hcloud_primary_ip.announce.ip_address
  description = "Reserved public IPv4 of the VM (hcloud_primary_ip.announce). It survives `terraform apply -replace=hcloud_server.announce`, so the A record for db.announce.aztec.network (var.domain) in AztecProtocol/foundation-iac is set once. Terraform does not manage DNS: point that record at this address before Caddy's ACME challenge can complete."
}

output "announce_server_name" {
  value       = hcloud_server.announce.name
  description = "Hetzner server name — also this VM's tailnet MagicDNS name. cloud-init passes the same value to both `hostname:` and `tailscale up --hostname=` (see cloud-init/announce.yaml.tftpl), so this is what `tailscale ssh root@<this value>` and the rendered Ansible inventory (ansible/inventory.yml.tftpl) both resolve against. It is not a public DNS name — Terraform does not manage db.announce.aztec.network (see the `domain` output) — but it IS the name that matters for reaching the VM as an operator now that port 22 is closed."
}

output "announce_data_volume_id" {
  value       = hcloud_volume.announce_data.id
  description = "Data volume id; hcloud automounts it at /mnt/HC_Volume_<id>. Resizing this volume later is `terraform apply` plus a manual `xfs_growfs` on the host."
}

output "domain" {
  value       = var.domain
  description = "The hostname this deployment is for (db.announce.aztec.network), echoed back for convenience when setting the DNS A record above."
}
