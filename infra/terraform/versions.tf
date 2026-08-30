terraform {
  required_version = ">= 1.5.0"

  # State is LOCAL for now (see the commented "s3" block below for why).
  # No backend block = terraform writes terraform.tfstate in this directory.
  # That file is git-ignored (see .gitignore) — it can still contain
  # sensitive values (e.g. the rendered Ansible inventory content, resource
  # IDs), so treat it like a secret on whatever machine runs `apply`.

  # --- Foundation remote state (NOT enabled yet) ---
  # This repo is personal until it graduates into the Foundation org. Wiring
  # it to the Foundation's shared state bucket before that graduation is the
  # wrong order — it would put a personal repo's state in a bucket other
  # Foundation modules assume is Foundation-owned. Local state is correct
  # for now; whoever applies this decides when (and if) to switch.
  #
  # To switch later: uncomment this block, fill in the real key if it
  # differs, then run `terraform init -migrate-state` — Terraform copies the
  # existing local state into the bucket in one step, no manual state
  # surgery required.
  #
  # backend "s3" {
  #   bucket = "aztec-foundation-terraform-state"
  #   key    = "announce-aztec-network"
  #   region = "eu-west-2"
  # }

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}
