# production — sized for the 2x capacity envelope AND the 50,000 lines/day
# load-test target. Every assumption behind these numbers is derived in
# README.md; the audit-partitioning prerequisite is stated there too.

project_id      = "pss-erp-510114"
environment     = "production"
region          = "asia-southeast2"
zone            = "asia-southeast2-a"
domain          = "psserp.co.id"
billing_account = "000000-000000-000000"

orders_per_day          = 3000
order_lines_per_day     = 30000
concurrent_users        = 500
load_test_lines_per_day = 50000

# 4 vCPU / 16 GiB. The workload at 2x envelope is not CPU-bound; the sizing
# covers the load-test target and gives headroom for the audit insert rate.
cloudsql_tier = "db-custom-4-16384"
# 3-year audit-inclusive projection is ~231 GB; 500 GB provisioned with a
# bounded 1,000 GB autoscale ceiling.
cloudsql_disk_size_gb             = 500
cloudsql_disk_autoresize_limit_gb = 1000
# 5 deployables x pools + worker + Keycloak + operational sessions.
cloudsql_max_connections = 300
# REGIONAL HA is mandatory: PLT-012 backup/restore evidence assumes a failover
# target, and a ZONAL instance is a single-operator-incident outage.
cloudsql_ha = true
# Reporting and DW extraction read here so analytics cannot starve operations
# (AGENTS.md 11.2).
cloudsql_read_replica = true

valkey_tier           = "STANDARD_1"
valkey_memory_size_gb = "2"

# MUST stay >= 1. The root module enforces this: a scaled-to-zero outbox
# dispatcher accumulates events with no visible symptom.
worker_min_instances = 1
api_concurrency      = 80
api_max_instances    = 12

keycloak_cpu    = "1000m"
keycloak_memory = "2Gi"

budget_display_name    = "PSS production monthly budget"
budget_amount_usd      = 900
budget_alert_emails    = ["engineering@psserp.co.id", "finance@psserp.co.id"]
budget_alert_threshold = 0.7

labels = {
  cost_center = "engineering"
  criticality = "tier-1"
}
