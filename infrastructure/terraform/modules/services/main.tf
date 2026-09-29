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
variable "image_repository" {
  type = string
}
variable "image_tag" {
  type = string
}
variable "database_secret_name" {
  type = string
}
variable "issuer_secret_name" {
  type = string
}
variable "audience_secret_name" {
  type = string
}
variable "jwks_uri_secret_name" {
  type = string
}
variable "redis_host" {
  type = string
}
variable "redis_port" {
  type = number
}
variable "redis_secret_name" {
  type = string
}
variable "media_bucket" {
  type = string
}
variable "concurrency" {
  type = number
}
variable "max_instances" {
  type = number
}
variable "worker_min_instances" {
  type = number
}
variable "idp_base_url" {
  type = string
}
variable "workload_identity" {
  type = string
}
variable "keycloak_cpu" {
  type = string
}
variable "keycloak_memory" {
  type = string
}

# The five deployables. All are deployed from ONE image tag so F0.md's
# "same-image promotion" requirement holds by construction: the tag is the git
# SHA, and no environment ever builds its own.
locals {
  request_serving = {
    api         = { port = 4000, min = 0, cpu = "1000m", memory = "512Mi" }
    finance-api = { port = 4001, min = 0, cpu = "1000m", memory = "512Mi" }
    geo-service = { port = 4003, min = 0, cpu = "1000m", memory = "512Mi" }
    web         = { port = 3000, min = 0, cpu = "1000m", memory = "512Mi" }
    # The outbox dispatcher polls. min-instances is validated >= 1 in the root
    # module so a scaled-to-zero worker cannot silently stop draining events.
    integration-worker = { port = 4002, min = 1, cpu = "1000m", memory = "512Mi" }
  }
}

resource "google_artifact_registry_repository" "apps" {
  project       = var.project_id
  location      = var.region
  repository_id = "${var.name_prefix}-apps"
  description   = "PSS deployable images, tagged with the git SHA"
  format        = "DOCKER"
  labels        = var.labels

  docker_config {
    # Keeps images in Jakarta with the rest of the data (PLT-000.R90).
    immutable_tags = true
  }
}

resource "google_cloud_run_v2_service" "app" {
  for_each = local.request_serving

  project  = var.project_id
  name     = "${var.name_prefix}-${each.key}"
  location = var.region
  labels   = var.labels
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account                  = var.workload_identity
    timeout                          = "60s"
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = each.value.min
      max_instance_count = var.max_instances
    }

    containers {
      image = "${var.image_repository}/${each.key}:${var.image_tag}"

      ports {
        container_port = each.value.port
      }

      resources {
        limits = {
          cpu    = each.value.cpu
          memory = each.value.memory
        }
        cpu_idle          = each.value.min > 0
        startup_cpu_boost = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "PORT"
        value = tostring(each.value.port)
      }

      env {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = "https://telemetry.googleapis.com"
      }

      env {
        name  = "OTEL_SERVICE_NAME"
        value = each.key
      }

      env {
        name  = "MEDIA_BUCKET"
        value = var.media_bucket
      }

      env {
        name  = "REDIS_HOST"
        value = var.redis_host
      }

      env {
        name  = "REDIS_PORT"
        value = tostring(var.redis_port)
      }

      # Secrets are resolved at runtime by the platform, never baked in.
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.database_secret_name
            version = "latest"
          }
        }
      }

      env {
        name = "PSS_OIDC_ISSUER"
        value_source {
          secret_key_ref {
            secret  = var.issuer_secret_name
            version = "latest"
          }
        }
      }

      env {
        name = "PSS_OIDC_AUDIENCE"
        value_source {
          secret_key_ref {
            secret  = var.audience_secret_name
            version = "latest"
          }
        }
      }

      env {
        name = "PSS_OIDC_JWKS_URI"
        value_source {
          secret_key_ref {
            secret  = var.jwks_uri_secret_name
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health/live"
          port = each.value.port
        }
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 12
      }

      liveness_probe {
        http_get {
          path = "/health/live"
          port = each.value.port
        }
        period_seconds    = 30
        failure_threshold = 3
      }
    }
  }

  depends_on = [google_artifact_registry_repository.apps]
}

# Keycloak is the IdP named as the default in the PRD (OD-120). It needs a real
# database, not the dev H2 store, so it is a sixth always-on service and the
# second-largest fixed cost in this stack after the database.
resource "google_cloud_run_v2_service" "keycloak" {
  project  = var.project_id
  name     = "${var.name_prefix}-keycloak"
  location = var.region
  labels   = var.labels
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account                  = var.workload_identity
    timeout                          = "60s"
    max_instance_request_concurrency = 100

    # Always on: an IdP that scales to zero breaks the login flow the five
    # deployables depend on for every authenticated request.
    scaling {
      min_instance_count = 1
      max_instance_count = 4
    }

    containers {
      image = "quay.io/keycloak/keycloak:26.7.4"

      args = [
        "start",
        "--optimized",
        "--hostname=${var.idp_base_url}",
        "--proxy-headers=xforwarded",
      ]

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.keycloak_cpu
          memory = var.keycloak_memory
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      env {
        name  = "KC_DB"
        value = "postgres"
      }

      env {
        name  = "KC_HOSTNAME_STRICT"
        value = "true"
      }

      env {
        name  = "KC_HEALTH_ENABLED"
        value = "true"
      }

      env {
        name = "KC_DB_URL"
        value_source {
          secret_key_ref {
            secret  = var.database_secret_name
            version = "latest"
          }
        }
      }
    }
  }

  deletion_protection = false
}

output "service_urls" {
  value = { for name, service in google_cloud_run_v2_service.app : name => service.uri }
}

output "keycloak_uri" { value = google_cloud_run_v2_service.keycloak.uri }

output "repository" { value = google_artifact_registry_repository.apps.name }
