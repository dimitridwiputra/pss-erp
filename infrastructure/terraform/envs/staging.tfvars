# staging — structural mirror of production (PLT-000.R90).
# Same tiers and the same always-on invariants as production, so a staging
# failure is representative. Data is masked; no production data (SEC-001).

project_id      = "pss-erp-510114"
environment     = "staging"
region          = "asia-southeast2"
zone            = "asia-southeast2-a"
domain          = "staging.psserp.co.id"
billing_account = "000000-000000-000000"

orders_per_day          = 3000
order_lines_per_day     = 30000
concurrent_users        = 500
load_test_lines_per_day = 30000

cloudsql_tier                     = "db-custom-4-16384"
cloudsql_disk_size_gb             = 250
cloudsql_disk_autoresize_limit_gb = 500
cloudsql_max_connections          = 200
cloudsql_ha                       = true
cloudsql_read_replica             = false

valkey_tier           = "STANDARD_1"
valkey_memory_size_gb = "1"

worker_min_instances = 1
api_concurrency      = 80
api_max_instances    = 8

budget_display_name    = "PSS staging monthly budget"
budget_amount_usd      = 400
budget_alert_emails    = ["engineering@psserp.co.id"]
budget_alert_threshold = 0.8

labels = {
  cost_center = "engineering"
}
