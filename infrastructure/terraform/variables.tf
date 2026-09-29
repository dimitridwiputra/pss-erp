variable "project_id" {
  description = "GCP project id. Must already exist and have billing enabled."
  type        = string
}

variable "billing_account" {
  description = "Billing account id the budget is attached to, e.g. 000000-000000-000000."
  type        = string
}

variable "environment" {
  description = "Environment name. One of dev, staging, production (PLT-000.R90)."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "PLT-000.R90 defines exactly dev, staging, and production."
  }
}

variable "region" {
  description = <<-EOT
    Region for all data at rest. PLT-000.R90 / ADR-0009 require the Jakarta region
    for data residency; do not change it without a new ADR.
  EOT
  type        = string
  default     = "asia-southeast2"
}

variable "zone" {
  description = "Primary zone inside var.region."
  type        = string
  default     = "asia-southeast2-a"
}

variable "domain" {
  description = "Apex DNS domain used for this environment, e.g. psserp.co.id."
  type        = string
}

# ---------------------------------------------------------------------------
# Capacity envelope
#
# Derived from the capacity brief. See README.md for the full derivation and for
# the assumptions that still need a business owner's confirmation (OD-41).
# ---------------------------------------------------------------------------

variable "orders_per_day" {
  description = "Expected sales orders per day at the 2x capacity envelope for this environment."
  type        = number
}

variable "order_lines_per_day" {
  description = "Expected sales-order lines per day at the 2x capacity envelope for this environment."
  type        = number
}

variable "concurrent_users" {
  description = "Target concurrent authenticated users, used to size Cloud Run concurrency and max instances."
  type        = number
}

variable "load_test_lines_per_day" {
  description = <<-EOT
    Peak sustainable lines/day the production environment must absorb during a load
    test without a database or queue bottleneck.
  EOT
  type        = number
}

# ---------------------------------------------------------------------------
# Data plane sizing
# ---------------------------------------------------------------------------

variable "cloudsql_tier" {
  description = "Cloud SQL machine tier. See README.md sizing table; OD-41 must confirm before production."
  type        = string
}

variable "cloudsql_disk_size_gb" {
  description = "Cloud SQL disk size in GB. Sized from the 3-year audit-retention projection in README.md."
  type        = number
}

variable "cloudsql_disk_autoresize_limit_gb" {
  description = "Upper bound for storage autoscaling, in GB, to stop unbounded spend."
  type        = number
}

variable "cloudsql_max_connections" {
  description = <<-EOT
    max_connections. Sized for the five deployables plus the worker plus operational
    sessions. Raise only together with the Postgres memory budget.
  EOT
  type        = number
}

variable "cloudsql_ha" {
  description = "Regional high availability. Must stay true for staging and production."
  type        = bool
}

variable "cloudsql_read_replica" {
  description = "Create a read replica for reporting and DW extraction (PLT-000.R94)."
  type        = bool
}

variable "valkey_tier" {
  description = "Memorystore for Valkey service tier, e.g. STANDARD_1."
  type        = string
}

variable "valkey_memory_size_gb" {
  description = "Memorystore for Valkey memory in GB. Sizing is in README.md; queue depth is not business-day volume."
  type        = string
}

# ---------------------------------------------------------------------------
# Compute sizing
# ---------------------------------------------------------------------------

variable "image_tag" {
  description = <<-EOT
    Container image tag to deploy. F0.md requires "same-image promotion", so this is
    the git commit SHA built once by CI (see .github/workflows/ci.yml) and reused
    across dev, staging, and production. Never build a tag per environment.
  EOT
  type        = string
  default     = "latest"
}

variable "worker_min_instances" {
  description = <<-EOT
    Minimum instances for the integration worker. MUST be at least 1: the outbox
    dispatcher is a poller, so a scaled-to-zero worker stops draining
    platform.outbox_event and events accumulate silently.
  EOT
  type        = number

  validation {
    condition     = var.worker_min_instances >= 1
    error_message = "The outbox dispatcher must never scale to zero (AGENTS.md 3.7: nothing silently disappears)."
  }
}

variable "api_concurrency" {
  description = "Cloud Run container concurrency for the request-serving services."
  type        = number
}

variable "api_max_instances" {
  description = "Cloud Run max instances per request-serving service, i.e. the concurrency budget."
  type        = number
}

variable "keycloak_cpu" {
  description = "Always-allocated CPU for Keycloak. See README.md for the memory cost."
  type        = string
  default     = "1000m"
}

variable "keycloak_memory" {
  description = "Keycloak memory. 2GiB is the documented floor for a JVM IdP in production."
  type        = string
  default     = "2Gi"
}

# ---------------------------------------------------------------------------
# Governance
# ---------------------------------------------------------------------------

variable "budget_display_name" {
  description = "Display name for the billing budget alert on this environment."
  type        = string
}

variable "budget_amount_usd" {
  description = "Monthly budget in USD. Alerts at 50/80/100%."
  type        = number
}

variable "budget_alert_emails" {
  description = "Who receives budget alerts. Must not be empty for production."
  type        = list(string)

  validation {
    condition     = length(var.budget_alert_emails) > 0
    error_message = "A budget with no alert recipient is a budget nobody watches. Set at least one address."
  }
}

variable "budget_alert_threshold" {
  description = "Percentage of budget that triggers an alert."
  type        = number
  default     = 0.8
}

variable "labels" {
  description = "Extra labels merged onto every resource."
  type        = map(string)
  default     = {}
}
