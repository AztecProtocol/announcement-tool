output "announce_server_ipv4" {
  value       = hcloud_server.announce.ipv4_address
  description = "Public IPv4 of the VM. Terraform does not manage DNS: before Caddy's ACME challenge for announce.aztec.network can complete, an A record for announce.aztec.network (var.domain) must be pointed at this address in whatever system controls the aztec.network nameservers."
}

output "announce_server_name" {
  value       = hcloud_server.announce.name
  description = "Hetzner server name (for console/API lookups). Not a DNS name — there is no MagicDNS here."
}

output "announce_data_volume_id" {
  value       = hcloud_volume.announce_data.id
  description = "Data volume id; hcloud automounts it at /mnt/HC_Volume_<id>. Resizing this volume later is `terraform apply` plus a manual `xfs_growfs` on the host."
}

output "domain" {
  value       = var.domain
  description = "The hostname this deployment is for (announce.aztec.network), echoed back for convenience when setting the DNS A record above."
}
