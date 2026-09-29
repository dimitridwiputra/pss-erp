variable "project_id" {
  type = string
}
variable "name_prefix" {
  type = string
}
variable "labels" {
  type = map(string)
}
variable "environment" {
  type = string
}

# Secret *names* only. Values are seeded out of band by an operator or by CI and
# are never written by Terraform, so no production credential is ever stored in
# state. AGENTS.md 15: no secret in the client bundle, no secret in logs.
resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-database-url"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "redis_url" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-redis-url"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "oidc_issuer" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-oidc-issuer"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "oidc_audience" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-oidc-audience"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "oidc_jwks" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-oidc-jwks-uri"
  labels    = var.labels

  replication {
    auto {}
  }
}

output "database_url_secret_name" { value = google_secret_manager_secret.database_url.secret_id }
output "redis_url_secret_name" { value = google_secret_manager_secret.redis_url.secret_id }
output "oidc_issuer_secret_name" { value = google_secret_manager_secret.oidc_issuer.secret_id }
output "oidc_audience_secret_name" { value = google_secret_manager_secret.oidc_audience.secret_id }
output "oidc_jwks_secret_name" { value = google_secret_manager_secret.oidc_jwks.secret_id }
