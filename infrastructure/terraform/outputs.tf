output "environment" {
  description = "Environment this state manages."
  value       = var.environment
}

output "region" {
  description = "All data at rest is pinned here (PLT-000.R90 / ADR-0009)."
  value       = var.region
}

output "api_base_url" {
  value = "https://api.${var.domain}"
}

output "web_base_url" {
  value = "https://app.${var.domain}"
}

output "idp_base_url" {
  value = "https://id.${var.domain}"
}

output "database_instance" {
  value = module.database.instance_name
}

output "database_private_ip" {
  description = "Operational Postgres private IP. Cloud Run reaches it over Private Google Access; there is no public address."
  value       = module.database.private_ip
}

output "reporting_replica" {
  value = module.database.replica_name
}

output "queue_host" {
  value = module.cache.host
}

output "buckets" {
  value = module.storage.bucket_names
}

output "service_urls" {
  value = module.services.service_urls
}

output "image_repository" {
  value = module.services.repository
}

output "workload_identity_member" {
  description = "Service account the five deployables run as. No JSON key exists anywhere."
  value       = module.network.workload_identity_member
}

output "secret_names" {
  description = <<-EOT
    Secret names only. Values are seeded out of band; Terraform never writes a
    credential into state.
  EOT
  value = {
    database_url  = module.secrets.database_url_secret_name
    redis_url     = module.secrets.redis_url_secret_name
    oidc_issuer   = module.secrets.oidc_issuer_secret_name
    oidc_audience = module.secrets.oidc_audience_secret_name
    oidc_jwks_uri = module.secrets.oidc_jwks_secret_name
  }
}

output "capacity_summary" {
  description = "The sizing inputs this environment was provisioned from, for the record."
  value = {
    orders_per_day          = var.orders_per_day
    order_lines_per_day     = var.order_lines_per_day
    concurrent_users        = var.concurrent_users
    load_test_lines_per_day = var.load_test_lines_per_day
    cloudsql_tier           = var.cloudsql_tier
    cloudsql_disk_gb        = var.cloudsql_disk_size_gb
    max_connections         = var.cloudsql_max_connections
    ha                      = var.cloudsql_ha
    read_replica            = var.cloudsql_read_replica
    valkey_tier             = var.valkey_tier
    worker_min_instances    = var.worker_min_instances
    budget_usd              = var.budget_amount_usd
  }
}
