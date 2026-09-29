# PLT-000.R92 / ARC section 18: a private network, managed container runtime, no Kubernetes.
# VPC-native is the default; Serverless NEGs reach Cloud Run without public IPs.

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
variable "environment" {
  type = string
}
variable "cloudsql_private" {
  type = bool
}

locals {
  subnet_cidr = "10.10.0.0/20"
  # No gcloud-managed default route is created, so egress must be explicit.
  application_cidr      = "10.10.16.0/20"
  private_service_range = "10.10.32.0/20"
}

resource "google_compute_network" "main" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "GLOBAL"
}

resource "google_compute_subnetwork" "application" {
  project       = var.project_id
  name          = "${var.name_prefix}-application"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = local.subnet_cidr

  private_ip_google_access = true

  depends_on = [google_compute_global_address.private_service_range]

  secondary_ip_range {
    range_name    = "application"
    ip_cidr_range = local.application_cidr
  }
}

# Cloud SQL and Memorystore reach their private ranges without a proxy; enabling
# Private Google Access is what makes that work (AGENTS.md 15: least privilege).
# Declared here so the ordering is explicit; the range is allocated by
# google_compute_global_address.private_service_range above.

# Egress for Cloud Run, Keycloak administration, and the worker. Sized for the
# documented 2x envelope; review before raising, see README.md "Capacity review".
resource "google_compute_router" "main" {
  project = var.project_id
  name    = "${var.name_prefix}-router"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  project                            = var.project_id
  name                               = "${var.name_prefix}-nat"
  region                             = var.region
  router                             = google_compute_router.main.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# One identity for the five deployables. Workload Identity is mandatory rather
# than preferred: AGENTS.md 15 forbids secrets in the client bundle, and long-lived
# service-account JSON keys are the usual way that rule gets broken.
resource "google_service_account" "workload" {
  project      = var.project_id
  account_id   = "pss-${var.environment}-workload"
  display_name = "PSS ${var.environment} deployable runtime"
  description  = "Cloud Run service identity for the five PSS deployables."
}

# Private Service Access must be allocated once per project before Cloud SQL or
# Memorystore can use private IPs.
#
# The Service Networking service agent needs roles/servicenetworking.networksAdmin
# to create the connection, and the Google-managed provider does not expose a
# resource for granting a service agent its own role. That grant is therefore a
# documented one-time bootstrap step in README.md, not something this stack can
# do idempotently. The connection below will fail on a brand-new project until it
# has been run.
resource "google_compute_global_address" "private_service_range" {
  project       = var.project_id
  name          = "${var.name_prefix}-psc-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  address       = cidrhost(local.private_service_range, 0)
  network       = google_compute_network.main.id
  labels        = var.labels
}

resource "google_service_networking_connection" "private_service" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_range.name]
}

output "network_name" { value = google_compute_network.main.name }
output "subnet_name" { value = google_compute_subnetwork.application.name }
output "service_networking_connection" { value = "servicenetworking.googleapis.com" }
output "application_cidr" { value = local.application_cidr }
output "workload_identity_account" { value = google_service_account.workload.email }
output "workload_identity_member" { value = "serviceAccount:${google_service_account.workload.email}" }
