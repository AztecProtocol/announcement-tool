terraform {
  required_version = ">= 1.5.0"

  # State lives in the Foundation's shared bucket, the same one the other
  # Foundation Terraform modules use. The bucket, region and key layout match
  # the aztec-observability module.
  #
  # State is not just a record. Terraform needs it to know what it already
  # created. Without it, a second `apply` builds a second VM and can no longer
  # manage the first. Remote state also means anyone with bucket access can
  # read the outputs (`terraform output announce_server_ipv4`), so the person
  # who applies and the person who sets the DNS record do not have to be the
  # same person.
  #
  # Warning: state records every value Terraform handles, including the
  # rendered Ansible inventory and resource IDs. Treat the bucket as holding
  # secrets. Do not make it public and do not copy state files around.
  #
  # If a local terraform.tfstate already exists from an earlier apply, run
  # `terraform init -migrate-state`. Terraform copies it into the bucket in
  # one step. A first-time apply needs only `terraform init`.
  backend "s3" {
    bucket = "aztec-foundation-terraform-state"
    key    = "announce-aztec-network"
    region = "eu-west-2"
  }

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
