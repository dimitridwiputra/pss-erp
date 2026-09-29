terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Each environment uses its own remote state. Run `terraform init -migrate-state`
  # only when deliberately moving an environment; never edit backend blocks in place.
  backend "gcs" {}
}
