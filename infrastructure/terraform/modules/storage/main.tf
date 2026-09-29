variable "project_id" {
  type = string
}
variable "name_prefix" {
  type = string
}
variable "region" {
  type = string
}
variable "location" {
  type = string
}
variable "labels" {
  type = map(string)
}
variable "buckets" {
  type = any
}
variable "web_origin" {
  type = string
}
variable "runtime_member" {
  type = string
}

# CMEK: the service agent that GCS itself uses to encrypt with these keys. The
# provider exposes no resource for it, so it is read rather than created. Run
# `terraform apply` once without the buckets if this is not yet populated.
data "google_storage_project_service_account" "gcs_agent" {
  project = var.project_id
}

# One bucket per class so retention and lifecycle can differ. PLT-011 names four:
# media, raw landing, backup, event archive.
resource "google_storage_bucket" "this" {
  for_each = var.buckets

  project                     = var.project_id
  name                        = "${var.name_prefix}-${each.key}"
  location                    = var.location
  storage_class               = "STANDARD"
  uniform_bucket_level_access = each.value.uniform_access
  force_destroy               = each.value.force_destroy
  labels                      = var.labels

  versioning {
    # Bucket versioning is the baseline protection; object versioning is what lets
    # a bad DEPLOYMENT be rolled back without losing evidence.
    enabled = true
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.bucket[each.key].id
  }

  lifecycle_rule {
    condition {
      age        = 3650
      with_state = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  cors {
    origin          = [var.web_origin]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "ETag", "x-goog-generation"]
    max_age_seconds = 3600
  }

}

# Envelope encryption with a per-bucket CMEK key, so a bucket's key can be
# revoked independently (AGENTS.md 15: encryption at rest).
resource "google_kms_key_ring" "objects" {
  project  = var.project_id
  name     = "${var.name_prefix}-objects"
  location = var.location
}

resource "google_kms_crypto_key" "bucket" {
  for_each = var.buckets

  name            = "${var.name_prefix}-${each.key}"
  key_ring        = google_kms_key_ring.objects.id
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "storage" {
  for_each = var.buckets

  crypto_key_id = google_kms_crypto_key.bucket[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  # The GCS service agent performs the encryption, so it is the member that needs
  # the key, not the runtime service account.
  member = "serviceAccount:${data.google_storage_project_service_account.gcs_agent.email_address}"
}

resource "google_storage_bucket_iam_member" "runtime_reader" {
  for_each = var.buckets

  bucket = google_storage_bucket.this[each.key].name
  role   = "roles/storage.objectViewer"
  member = var.runtime_member
}

output "bucket_names" { value = { for key, bucket in google_storage_bucket.this : key => bucket.name } }
output "media_bucket" { value = google_storage_bucket.this["media"].name }
