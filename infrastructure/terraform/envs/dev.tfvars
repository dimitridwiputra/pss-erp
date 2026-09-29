# dev — local-parity pilot environment.
# Cheapest configuration that still runs all five deployables plus Keycloak.
# Not a production shape: ZONAL, no read replica, small disk.

environment     = "dev"
region          = "asia-southeast2"
zone            = "asia-southeast2-a"
domain          = "dev.psserp.co.id"
billing_account = "000000-000000-000000"

orders_per_day          = 1500
order_lines_per_day     = 15000
concurrent_users        = 100
load_test_lines_per_day = 5000

cloudsql_tier                     = "db-custom-2-8192"
cloudsql_disk_size_gb             = 50
cloudsql_disk_autoresize_limit_gb = 100
cloudsql_max_connections          = 100
cloudsql_ha                       = false
cloudsql_read_replica             = false

valkey_tier           = "BASIC"
valkey_memory_size_gb = "1"

worker_min_instances = 1
api_concurrency      = 80
api_max_instances    = 4

budget_display_name    = "PSS dev monthly budget"
budget_amount_usd      = 150
budget_alert_emails    = ["engineering@psserp.co.id"]
budget_alert_threshold = 0.8

labels = {
  cost_center = "engineering"
}
