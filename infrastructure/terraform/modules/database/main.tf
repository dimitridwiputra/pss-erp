variable "project_id" {
  type = string
}
variable "name_prefix" {
  type = string
}
variable "region" {
  type = string
}
variable "labels" {
  type = map(string)
}

variable "tier" {
  type = string
}
variable "disk_size_gb" {
  type = number
}
variable "disk_autoresize_limit_gb" {
  type = number
}
variable "max_connections" {
  type = number
}
variable "ha_enabled" {
  type = bool
}
variable "read_replica" {
  type = bool
}
variable "backup_retention_days" {
  type = number
}
variable "application" {
  type = string
}
variable "network" {
  type = any
}

# Operational data. The database user is a dedicated least-privilege role; the
# owner password is never stored in Terraform state, only a random one is created
# and rotated by the secret manager (AGENTS.md 15).
resource "google_sql_database_instance" "operational" {
  project             = var.project_id
  name                = "${var.name_prefix}-operational"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = true

  settings {
    tier                        = var.tier
    availability_type           = var.ha_enabled ? "REGIONAL" : "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.disk_size_gb
    disk_autoresize             = true
    disk_autoresize_limit       = var.disk_autoresize_limit_gb
    deletion_protection_enabled = true

    ip_configuration {
      private_network = var.network.network_name
      ipv4_enabled    = false
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      # Never record client addresses: PII (SEC-001, UU PDP).
      record_client_address = false
    }

    backup_configuration {
      enabled            = true
      binary_log_enabled = true
      start_time         = "02:00"

      transaction_log_retention_days = 7

      # This is the evidence PLT-012 and OD-188 need for managed PITR.
      point_in_time_recovery_enabled = true

      backup_retention_settings {
        retained_backups = var.backup_retention_days
        retention_unit   = "COUNT"
      }
    }

    database_flags {
      name  = "max_connections"
      value = tostring(var.max_connections)
    }

    user_labels = var.labels
  }

  lifecycle {
    # Changing the machine tier or HA mode recreates the instance. Require an
    # explicit confirmation so a routine `terraform apply` cannot cause an outage.
    prevent_destroy = true
  }
}

resource "google_sql_database" "operational" {
  project  = var.project_id
  instance = google_sql_database_instance.operational.name
  name     = var.application
}

# Reporting and DW extraction read from a replica so a heavy analytics query can
# not starve the operational workload (AGENTS.md 11.2: the app must not read DW
# marts as transactional truth, so the extraction path is deliberately separate).
resource "google_sql_database_instance" "reporting_replica" {
  count = var.read_replica ? 1 : 0

  project             = var.project_id
  name                = "${var.name_prefix}-reporting"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = true

  master_instance_name = google_sql_database_instance.operational.name

  settings {
    tier                        = var.tier
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.disk_size_gb
    disk_autoresize             = true
    disk_autoresize_limit       = var.disk_autoresize_limit_gb
    deletion_protection_enabled = true

    ip_configuration {
      private_network = var.network.network_name
      ipv4_enabled    = false
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    insights_config {
      query_insights_enabled = true
      record_client_address  = false
    }

    user_labels = var.labels
  }

  depends_on = [google_sql_database_instance.operational]
}

# Cloud SQL is reachable only from the application subnetwork.
resource "google_sql_user" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.operational.name
  name     = "pss_app"
  password = random_password.app.result
}

resource "random_password" "app" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

output "instance_name" { value = google_sql_database_instance.operational.name }
output "database_name" { value = google_sql_database.operational.name }
output "private_ip" { value = google_sql_database_instance.operational.private_ip_address }
output "replica_name" { value = try(google_sql_database_instance.reporting_replica[0].name, null) }
output "app_password" {
  value     = random_password.app.result
  sensitive = true
}
output "connection_name" { value = google_sql_database_instance.operational.connection_name }
