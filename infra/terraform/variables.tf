# --- provider credentials ---

variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token for the project this VM is created in. No default: an unset token must stop the plan, not silently fail against the wrong project. Unlike the aztec-observability module, this is a plain Terraform variable (set via TF_VAR_hcloud_token or a local, git-ignored .tfvars), not an SSM read — this repo has no Foundation AWS account coupling yet, matching the local-state decision in versions.tf."
}

variable "tailscale_api_key" {
  type        = string
  sensitive   = true
  description = "Tailscale API key used to mint this VM's tailnet auth key through api.tailscale.com. No default: an unset credential must stop the plan. Without it the provider falls back to whatever ambient credential exists, which either fails outright or, worse, succeeds against the wrong tailnet — see var.tailnet. Supplied the same way as hcloud_token above, as TF_VAR_tailscale_api_key or a .tfvars entry. The aztec-observability sibling instead reads OAuth credentials from AWS SSM parameters owned by rpc.aztec.foundation; this module does not, because it has no other SSM coupling and would then depend on parameters this repository does not control. The cost of that choice: this key is not rotated centrally, so rotate it here too."
}

# --- server ---

variable "hcloud_location" {
  type        = string
  default     = "fsn1"
  description = "Hetzner location for the VM. FSN1 (Falkenstein) is Hetzner's original EU region with the widest server-type availability; no other constraint (no tailnet region-latency concern here) pulls this elsewhere."
}

variable "server_type" {
  type        = string
  default     = "cx22"
  description = "Hetzner server type. This VM is not a metrics TSDB — it runs Postgres for a low-volume workload (a few announcements a month, a subscriber list, and a delivery ledger), plus two small containers (signal-cli-rest-api, Caddy) and a nightly backup job. Note signal-cli-rest-api is a JVM (signal-cli runs on Java): it idles around 200-400 MB in native/json-rpc mode, more in normal mode where it restarts the JVM per call — real but bounded memory, not negligible. cx22 (2 shared vCPU / 4 GB RAM) still covers Postgres + that JVM + Caddy with headroom; the aztec-observability module's ccx23 (4 dedicated vCPU / 16 GB, sized for a ~700GB Prometheus+Loki TSDB) would be paying for ingest capacity this workload never approaches. Do not resize on account of signal-cli-rest-api alone — it fits."
}

variable "image" {
  type        = string
  default     = "ubuntu-24.04"
  description = "Base image. Matches the aztec-observability module's choice for consistency across the author's Hetzner modules; Ansible provisions everything else. Note: `image` is in this server's ignore_changes list (see vm.tf), so bumping this variable produces no plan diff — Terraform will report \"no changes\" even though the value changed. An OS upgrade is a deliberate rebuild (new server, migrate the volume), never a variable bump."
}

variable "data_volume_size_gb" {
  type        = number
  default     = 20
  description = "Data volume for the Postgres data directory, sized for a few announcements a month, a subscriber list, and a delivery/audit ledger — not a metrics TSDB. 20 GB gives a small database years of headroom plus room for nightly backup archives on the same volume. Online-resizable (grow, never shrink): resize here with terraform apply, then run xfs_growfs on the host by hand — Terraform cannot do the filesystem step itself."
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key installed on this VM. Optional, and not an access path. Day-2 access is `tailscale ssh` over the tailnet, and Ansible authenticates the same way (see ../ansible/inventory.yml.tftpl), not with this key. The Hetzner console is a VNC session at a login prompt, so it never presents this key, and a stock Ubuntu image ships with root's password locked. If the tailnet join fails, recovery is Hetzner rescue mode: boot rescue, mount the root disk, fix Tailscale or set a password, reboot. Supply a key only if you want one on the box for a path you plan to open yourself, such as a temporary port-22 rule after a rescue-mode repair. If you do supply one, it must be different key material from any other module's key in the same Hetzner project — Hetzner rejects a duplicate fingerprint and the apply fails."
  default     = null
}

# --- tailnet ---

variable "tailnet" {
  type        = string
  description = "The Tailscale tailnet (organization) this VM joins, e.g. \"example.com\" or a tailnet's -example.ts.net name. Matches the aztec-observability sibling's tailnet — this VM and the fleet it needs to be reachable alongside share one tailnet, not one per module. Getting this wrong does not fail loudly: the auth key still generates and `tailscale up` still runs, but the VM joins the wrong organization's network and stays unreachable from where operators actually are, which looks identical to a boot failure until someone checks which tailnet the host landed in."
}

variable "tailscale_acl_tag" {
  type        = string
  default     = "tag:announce"
  description = "The ACL tag applied to this VM's tailnet auth key, and therefore to the node once it joins. PREREQUISITE, decided by the owner, and NOT something this module can satisfy on its own: `tag:announce` must already exist in the tailnet's ACL policy before this module is applied. That ACL is a singleton owned by a different repository and module — `rpc.aztec.foundation/tailscale.tf` in AztecProtocol/foundation-iac, applied with `overwrite_existing_content = true` — so the tag has to be added there, in code, and that module applied, before this one runs; it cannot be added by hand in the Tailscale admin console, because the next apply of that module treats the console edit as drift and reverts it. If the tag is missing when this module applies, `tailscale_tailnet_key` creation (or the `tailscale up` call in cloud-init, depending on where Tailscale rejects it) fails with an unknown-tag error, and if that failure is somehow missed, the VM boots with no reachable path in at all — no SSH port, and no working tailnet join. Do not attempt to create this tag from this repository; it is owned elsewhere."
}

# --- application context (used only in output/inventory text, not to configure the VM directly) ---

variable "domain" {
  type        = string
  default     = "db.announce.aztec.network"
  description = "Public hostname this VM will serve. Terraform does not manage DNS here (the aztec.network nameservers are outside this repo's control) — this value is only used to make the required manual DNS step explicit in outputs.tf. An A record for this name must point at the VM's public IPv4 (see the observability apply pattern) before Caddy's ACME challenge can complete."
}
