# --- provider credentials ---

variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token for the project this VM is created in. No default: an unset token must stop the plan, not silently fail against the wrong project. Unlike the aztec-observability module, this is a plain Terraform variable (set via TF_VAR_hcloud_token or a local, git-ignored .tfvars), not an SSM read — this repo has no Foundation AWS account coupling yet, matching the local-state decision in versions.tf."
}

variable "tailscale_api_key" {
  type        = string
  sensitive   = true
  description = "Tailscale API key (or OAuth client secret — either credential shape the tailscale provider accepts) used to mint this VM's tailnet auth key via api.tailscale.com. No default: an unset credential must stop the plan, not fall through to whatever tailnet happens to own an ambient credential. This is deliberately a plain TF_VAR_tailscale_api_key/.tfvars variable, the same shape as hcloud_token above, and NOT the aztec-observability sibling's approach (that module reads oauth_client_id/oauth_client_secret from AWS SSM parameters under /rpc/tailscale/, provisioned by rpc.aztec.foundation). Two reasons to diverge here rather than copy that: this module already has no SSM coupling (see hcloud_token's description — it is local-state, no Foundation AWS account dependency yet), and adding one just for this credential would mean depending on SSM parameters this repo does not own or control existing; and the operator-facing pattern this module already teaches (Hetzner token as a TF_VAR/.tfvars secret) stays consistent instead of the operator learning a second, SSM-shaped credential-supply method for one variable. The cost of that choice: unlike the sibling, this key is not centrally rotated by rpc.aztec.foundation's SSM parameters, so if it is ever rotated, update it here too. CRITICAL: this variable existing is not enough by itself — it must be wired into a `provider \"tailscale\"` block (see providers.tf) or Terraform silently falls back to an unauthenticated/ambient-credential provider configuration, which either fails outright or, worse, succeeds against the wrong tailnet (see var.tailnet's description)."
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
  description = "SSH public key installed on this VM. No longer the operator's day-2 access path — that is `tailscale ssh` over the tailnet now (see the tailnet variables below) — and kept for a narrower reason than it might look: the true break-glass path, matching the aztec-observability sibling, is the Hetzner web console. That console is a VNC keyboard-and-screen session at a boot-time `login:` prompt, not an SSH endpoint — this key is never presented there, and a stock Ubuntu cloud image ships with root's password locked, so neither the key nor a password gets an operator in through the console alone. The actual recovery procedure if the tailnet join fails is Hetzner rescue mode: boot the rescue system, mount the root disk, and either fix networking/Tailscale or set a password from inside the mounted filesystem, then reboot. Ansible itself connects over `tailscale ssh` (Tailscale's own SSH, authenticated by tailnet identity/ACL — see ansible/inventory.yml.example), not this key, so this variable's only remaining real function is being present on the host in case some future access path needs it; it stays required, matching the aztec-observability sibling, rather than being dropped, so a key exists on the box before anyone needs one, instead of that being one more thing to arrange during an actual incident. Must be different key material from any other module's ssh_public_key applied into the same Hetzner project (e.g. aztec-observability's) — Hetzner rejects a duplicate fingerprint outright, so reusing a key here would fail the apply."
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
