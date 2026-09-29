variable "project_id" {
  type = string
}
variable "name_prefix" {
  type = string
}
variable "domain" {
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
variable "budget_display_name" {
  type = string
}
variable "budget_amount_usd" {
  type = number
}
variable "budget_alert_emails" {
  type = list(string)
}
variable "budget_alert_threshold" {
  type = number
}
variable "api_base_url" {
  type = string
}
variable "web_base_url" {
  type = string
}
variable "log_retention_days" {
  type = number
}
variable "billing_account" {
  type = string
}
variable "audit_bucket_name" {
  type = string
}
variable "runtime_member" {
  type = string
}

# Pay-as-you-go needs a hard stop. GCP does not cap spend by default, so without
# this a runaway log sink or an autoscaling disk bills without limit.
#
# A budget ALERTS; it does not cut off services. Enforcing a ceiling needs billing
# to be paused manually, which is deliberate: an automatic shutdown of the
# operational ERP is worse than a large bill, and that trade-off is Management's
# call under OD-188, not a Terraform default.
resource "google_billing_budget" "environment" {
  billing_account = var.billing_account
  display_name    = var.budget_display_name

  budget_filter {
    labels = { environment = var.environment }
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = var.budget_alert_threshold
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  # Forecast alerts catch a trend before the month ends, which is the only useful
  # time to react to a fixed budget.
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}

resource "google_monitoring_alert_policy" "api_down" {
  display_name = "${var.name_prefix}-api-unavailable"
  combiner     = "OR"

  conditions {
    display_name = "api 5xx above threshold"
    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"run.googleapis.com/request_count\"",
        "resource.type=\"cloud_run_revision\"",
        "metric.label.\"response_code_class\"=\"5xx\"",
        "resource.labels.service_name=\"api\"",
      ])
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 20
      duration        = "300s"
    }
  }

  documentation {
    content   = "Raised when the ${var.environment} API returns sustained 5xx. Check logs and the last deploy before assuming an upstream fault."
    mime_type = "text/markdown"
  }
}

# Outbox lag is the platform's own health signal: if the worker stalls, undelivered
# events accumulate in platform.outbox_event and nothing else fails visibly
# (AGENTS.md 3.7). The metric is not emitted yet; the policy is created so the
# alert is wired the moment @pss/observability ships the exporter (F0-02).
resource "google_monitoring_alert_policy" "outbox_lag" {
  display_name = "${var.name_prefix}-outbox-lag"
  combiner     = "OR"

  conditions {
    display_name = "oldest undelivered outbox event"
    condition_threshold {
      filter = "metric.type=\"custom.googleapis.com/pss/outbox/oldest_pending_seconds\""
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_MAX"
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 300
      duration        = "600s"
    }
  }

  documentation {
    content   = "Oldest undispatched outbox event older than five minutes. The integration worker is the usual cause."
    mime_type = "text/markdown"
  }
}

# Audit is the compliance record (AGENTS.md 14). It goes to its own bucket with a
# longer retention than application logs and no lifecycle deletion of recent data.
resource "google_logging_project_sink" "audit" {
  name                   = "${var.name_prefix}-audit"
  destination            = "storage.googleapis.com/${var.audit_bucket_name}"
  filter                 = "logName:\"audit\" OR jsonPayload.action != \"\""
  unique_writer_identity = true
}

resource "google_storage_bucket_iam_member" "audit_writer" {
  bucket = var.audit_bucket_name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.audit.writer_identity
}

resource "google_project_iam_member" "run_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = var.runtime_member
}

output "budget_display_name" {
  value = google_billing_budget.environment.display_name
}

output "alert_policies" {
  value = [
    google_monitoring_alert_policy.api_down.name,
    google_monitoring_alert_policy.outbox_lag.name,
  ]
}

output "audit_sink" {
  value = google_logging_project_sink.audit.name
}
