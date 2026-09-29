# ADR-0009 — Hosting: Google Cloud, Jakarta region

- **Status:** Proposed (supersedes the "vendor = OPEN" placeholder in Appendix K)
- **Decides:** OD-119 (cloud vendor and data residency)
- **Relates to:** ADR-0010 (IdP), ADR-0005 (outbox), PLT-000.R90–R94, ARC §6, ARC §18
- **Date:** 29 September 2026

## Context

PLT-000.R90 fixes the shape of the answer before the vendor is chosen: a cloud
provider in the **Jakarta region**, managed PostgreSQL with PostGIS, managed Redis,
S3-compatible object storage, a managed container runtime for **five deployables plus
Keycloak**, three environments, and IaC as a hard requirement. ARC §18 excludes
Kubernetes. Data residency is not only a preference here: PSS stores Indonesian
personal data (NIK, NPWP, owner phone numbers, worker locations), so where the data
physically sits is a legal question under UU PDP, not only an engineering one.

Three candidate shapes were considered. The first two were rejected on verifiable
grounds, recorded here so the choice is not relitigated from memory.

## Decision

Google Cloud, primary region `asia-southeast2` (Jakarta), with:

| Requirement | Service |
|---|---|
| PostgreSQL 17 + PostGIS | Cloud SQL for PostgreSQL |
| Redis | Memorystore for Valkey (confirmed available in Jakarta) |
| S3-compatible object storage | Cloud Storage, four CMEK-encrypted buckets |
| Container runtime, no Kubernetes | Cloud Run (five deployables + Keycloak) |
| Secret manager | Secret Manager, with Workload Identity, no JSON keys |
| IaC | Terraform, per-environment GCS state |

Configuration: `infrastructure/terraform/`.

## Alternatives considered

### Vercel + Supabase — rejected

| Problem | Detail |
|---|---|
| Not Jakarta | Neither service offers a Jakarta region. Vercel's nearest are Singapore/Tokyo; Supabase's is Singapore. This alone contradicts R90. |
| No container runtime | Vercel builds Next.js and functions from source. It cannot run the project's five Docker images, so F0.md's "same-image promotion" requirement is unachievable. |
| No Redis | BullMQ needs it; neither service provides it. |
| No Keycloak | Keycloak is the PRD's default IdP (OD-120). A JVM service has no home, and swapping to Supabase Auth would rewrite the delivered IDN-001 slice. |
| Terms | Vercel's own documentation restricts the Hobby plan to "non-commercial, personal use only". This is a company ERP. |
| Backup evidence | Supabase's free tier pauses inactive projects and does not permit database backup download, so PLT-012 and OD-188 evidence cannot be produced. |

### Supabase alone — partially viable, not sufficient

Supabase is a genuinely good fit for the *data plane*: managed Postgres with PostGIS
and S3-compatible storage. It was rejected as the whole answer for the same two
reasons that matter: no Jakarta region, and no home for the four Node services, Redis,
or Keycloak.

### A bare VPS in Jakarta — viable, weaker

Meets the region requirement and could host everything. Rejected because the PRD
asks for *managed* services and a managed container runtime, and because patching
Postgres, Redis, TLS, backups, and OS security on a single host is exactly the
operational load PLT-011 exists to remove. Retained as the fallback if Jakarta-region
managed services prove commercially unavailable.

## Consequences

**Accepted**

- PostGIS, a managed Redis, and container execution all exist in the Jakarta region,
  so the PRD's requirement is satisfiable for the first time.
- Data residency is met for the database, cache, and object storage.
- No Kubernetes, per ARC §18.
- Pay-as-you-go plus a $300 new-account credit.

**Costs that must be stated honestly**

- This is not a free-tier architecture. Cloud Run's free tier covers roughly 7% of one
  always-on vCPU, and Cloud SQL and Memorystore have no always-free tier at all.
  Steady state is roughly $150–350/month; the credit is a bridge, not a plan.
- A GCP budget **alerts**; it does not cut off services. Enforcing a ceiling means
  pausing billing, which is deliberately not automated here: an automatic shutdown of
  the operational ERP is worse than a large bill, and that trade-off belongs to
  Management under OD-188.

**Obligations this creates**

- A budget alert is mandatory on every environment, not optional.
- `audit.audit_entry` is the dominant table by roughly 3x (≈225,000 rows/day) and
  **must be range-partitioned by month before production**. See
  `domains/audit/infrastructure/database/migrations/0003_audit_entry_partitioning_prereq.sql`.
- Two capacity assumptions are unmeasured and must be confirmed before production:
  audit rows per mutation (assumed 3) and inventory movements per line (assumed 2).
  Both are recorded in `infrastructure/terraform/README.md`.

**Not decided here**

- OD-185, the observability backend and its cost. Cloud Monitoring is the obvious
  candidate but the PRD assigns that decision to Engineering; it is a separate ADR.
- OD-188, RPO/RTO and backup retention. The 35-day retention in the Terraform config
  is a placeholder, not an approved value.
- OD-123, the official document scheme and branch codes, which gate DOC-001 issuance.

## Fitness tests

1. `terraform validate` passes and all three environments produce a clean plan.
2. Every resource in every environment resolves to `asia-southeast2`.
3. `worker_min_instances` cannot be set below 1 (a scaled-to-zero outbox dispatcher
   accumulates events with no visible symptom).
4. `budget_alert_emails` cannot be empty.
5. No production region appears outside Indonesia.
6. A production deploy uses the same image digest as staging.
