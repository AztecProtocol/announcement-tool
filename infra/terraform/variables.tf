# --- provider credentials ---

variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token for the project this VM is created in. No default: an unset token must stop the plan, not silently fail against the wrong project. Unlike the aztec-observability module, this is a plain Terraform variable (set via TF_VAR_hcloud_token or a local, git-ignored .tfvars), not an SSM read — this repo has no Foundation AWS account coupling yet, matching the local-state decision in versions.tf."
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
  description = "SSH public key installed on this VM for Ansible and break-glass access. Must be different key material from any other module's ssh_public_key applied into the same Hetzner project (e.g. aztec-observability's) — Hetzner rejects a duplicate fingerprint outright, so reusing a key here would fail the apply."
}

# --- firewall ---

variable "operator_ssh_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to reach port 22. Required, no default: Terraform must refuse to plan until this is set explicitly. There is no tailnet on this deployment (decided 2026-08-27), so there is no `tailscale ssh`; Ansible and any operator login need a real, direct path to port 22, which means this firewall rule is the only thing standing between the VM and the whole internet on that port. Defaulting this to 0.0.0.0/0 to make the plan 'just work' would silently open SSH to everyone; leaving it unset and erroring is the safe failure mode. Set it to your actual office/VPN/home CIDR(s), e.g. [\"203.0.113.4/32\"]."
}

# --- application context (used only in output/inventory text, not to configure the VM directly) ---

variable "domain" {
  type        = string
  default     = "db.announce.aztec.network"
  description = "Public hostname this VM will serve. Terraform does not manage DNS here (the aztec.network nameservers are outside this repo's control) — this value is only used to make the required manual DNS step explicit in outputs.tf. An A record for this name must point at the VM's public IPv4 (see the observability apply pattern) before Caddy's ACME challenge can complete."
}
