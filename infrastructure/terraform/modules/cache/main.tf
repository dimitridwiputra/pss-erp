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
variable "memory_gb" {
  type = string
}
variable "network" {
  type = any
}

# BullMQ's Redis holds in-flight and delayed jobs, not business-day volume. Sizing
# therefore follows peak queue depth (README.md), which is orders of magnitude
# below the database. Memorystore for Valkey, not Redis Cluster: BullMQ needs a
# single logical primary, and Redis Cluster changes key semantics.
resource "google_redis_instance" "queue" {
  project        = var.project_id
  name           = "${var.name_prefix}-queue"
  region         = var.region
  tier           = var.tier
  memory_size_gb = var.memory_gb
  redis_version  = "VALKEY_8_0"

  # In-transit encryption: the queue carries canonical business payloads.
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  auth_enabled            = true

  # A replica is the failover target. A lost queue must not lose an outbox event,
  # which is exactly the "silently disappears" failure AGENTS.md 3.7 forbids.
  replica_count      = 1
  read_replicas_mode = "READ_REPLICAS_ENABLED"

  authorized_network = var.network.network_name
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  labels             = var.labels

  # noeviction, not allkeys-lru. Evicting a delayed job would drop an event
  # without a trace, so under memory pressure BullMQ must fail loudly instead.
  redis_configs = {
    maxmemory-policy       = "noeviction"
    notify-keyspace-events = "KEA"
  }

  # RDB snapshots. The queue is a transport, not a system of record: every event
  # is already durable in platform.outbox_event before it is enqueued, so a lost
  # Redis is recovered by re-dispatching, not by restoring Redis. AOF is
  # deliberately not enabled: it costs continuous write IOPS to protect data
  # that already has a durable source.
  persistence_config {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "TWENTY_FOUR_HOURS"
  }

  maintenance_policy {
    weekly_maintenance_window {
      day = "TUESDAY"
      start_time {
        hours = 3
      }
    }
  }
}

output "host" {
  value = google_redis_instance.queue.host
}

output "port" {
  value = google_redis_instance.queue.port
}

output "read_endpoint" {
  value = google_redis_instance.queue.read_endpoint
}
