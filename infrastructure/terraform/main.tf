provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# The state bucket and the Cloud SQL instance are created by a separate
# bootstrap stack (see README.md "Bootstrapping"). Initialising this stack
# therefore needs a backend that already exists:
#
#   terraform init \
#     -backend-config="bucket=<state-bucket>" \
#     -backend-config="prefix=pss/<environment>"
#
resource "google_project_service" "required" {
  for_each = toset([
    "compute.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "storage.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "dns.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudbilling.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "iam.googleapis.com",
  ])

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# ---------------------------------------------------------------------------
# Naming and labels
# ---------------------------------------------------------------------------

locals {
  name_prefix = "pss-${var.environment}"

  common_labels = merge(
    {
      project     = "pss-erp"
      environment = var.environment
      managed_by  = "terraform"
      region_code = "jakarta"
    },
    var.labels,
  )

  # Region pinning is deliberate and applies to data at rest AND to backups.
  backup_retention_days = var.environment == "production" ? 35 : 14
}

# ---------------------------------------------------------------------------
# Networking (PLT-000.R92: private network, no Kubernetes per ARC section 18)
# ---------------------------------------------------------------------------

module "network" {
  source = "./modules/network"

  project_id       = var.project_id
  name_prefix      = local.name_prefix
  region           = var.region
  labels           = local.common_labels
  environment      = var.environment
  cloudsql_private = var.environment != "dev"
}

# ---------------------------------------------------------------------------
# Data plane
# ---------------------------------------------------------------------------

module "database" {
  source = "./modules/database"

  project_id               = var.project_id
  name_prefix              = local.name_prefix
  region                   = var.region
  labels                   = local.common_labels
  tier                     = var.cloudsql_tier
  disk_size_gb             = var.cloudsql_disk_size_gb
  disk_autoresize_limit_gb = var.cloudsql_disk_autoresize_limit_gb
  max_connections          = var.cloudsql_max_connections
  ha_enabled               = var.cloudsql_ha
  read_replica             = var.cloudsql_read_replica
  backup_retention_days    = local.backup_retention_days
  network                  = module.network
  application              = "pss-operational"
}

module "cache" {
  source = "./modules/cache"

  project_id  = var.project_id
  name_prefix = local.name_prefix
  region      = var.region
  labels      = local.common_labels
  tier        = var.valkey_tier
  memory_gb   = var.valkey_memory_size_gb
  network     = module.network
}

# ---------------------------------------------------------------------------
# Object storage: the four buckets PLT-011 requires, each encrypted with its own key
# ---------------------------------------------------------------------------

module "storage" {
  source = "./modules/storage"

  project_id     = var.project_id
  name_prefix    = local.name_prefix
  region         = var.region
  labels         = local.common_labels
  location       = "ASIA"
  web_origin     = "https://app.${var.domain}"
  runtime_member = module.network.workload_identity_member
  buckets = {
    # Media and evidence (MED-001). WORM retention is applied by the object lifecycle.
    media = { uniform_access = true, force_destroy = false }
    # Raw connector landing; never deleted by lifecycle (AGENTS.md 12: replayable).
    raw_landing = { uniform_access = true, force_destroy = false }
    # Backup and DR artefacts.
    backup = { uniform_access = true, force_destroy = false }
    # Outbox event archive. Retained past inbox dedupe so replay stays possible.
    event_archive = { uniform_access = true, force_destroy = false }
  }
}

# ---------------------------------------------------------------------------
# Runtime: five deployables plus Keycloak
# ---------------------------------------------------------------------------

module "secrets" {
  source = "./modules/secrets"

  project_id  = var.project_id
  name_prefix = local.name_prefix
  labels      = local.common_labels
  environment = var.environment
}

module "services" {
  source = "./modules/services"

  project_id           = var.project_id
  name_prefix          = local.name_prefix
  region               = var.region
  labels               = local.common_labels
  image_repository     = "${var.region}-docker.pkg.dev/${var.project_id}/${local.name_prefix}-apps"
  image_tag            = var.image_tag
  database_secret_name = module.secrets.database_url_secret_name
  issuer_secret_name   = module.secrets.oidc_issuer_secret_name
  audience_secret_name = module.secrets.oidc_audience_secret_name
  jwks_uri_secret_name = module.secrets.oidc_jwks_secret_name
  redis_host           = module.cache.host
  redis_port           = module.cache.port
  redis_secret_name    = module.secrets.redis_url_secret_name
  media_bucket         = module.storage.bucket_names["media"]
  concurrency          = var.api_concurrency
  max_instances        = var.api_max_instances
  worker_min_instances = var.worker_min_instances
  idp_base_url         = "https://id.${var.domain}"
  workload_identity    = module.network.workload_identity_account
  keycloak_cpu         = var.keycloak_cpu
  keycloak_memory      = var.keycloak_memory
}

# ---------------------------------------------------------------------------
# Governance: budget, DNS, monitoring
# ---------------------------------------------------------------------------

module "governance" {
  source = "./modules/governance"

  project_id             = var.project_id
  name_prefix            = local.name_prefix
  domain                 = var.domain
  region                 = var.region
  labels                 = local.common_labels
  environment            = var.environment
  budget_display_name    = var.budget_display_name
  budget_amount_usd      = var.budget_amount_usd
  budget_alert_emails    = var.budget_alert_emails
  budget_alert_threshold = var.budget_alert_threshold
  api_base_url           = "https://api.${var.domain}"
  web_base_url           = "https://app.${var.domain}"
  log_retention_days     = var.environment == "production" ? 30 : 7
  billing_account        = var.billing_account
  audit_bucket_name      = module.storage.bucket_names["backup"]
  runtime_member         = module.network.workload_identity_member
}
