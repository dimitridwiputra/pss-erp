# Capacity brief and sizing rationale

Derived from the capacity brief supplied for this sprint. This file records the
arithmetic so a reviewer can challenge any number without reading the HCL, and
so the assumptions that still need sign-off stay visible.

## Inputs

| Quantity | Initial | 2x capacity envelope | Load-test target |
|---|---|---|---|
| Sales orders/day | 1,500 | 3,000 | — |
| Order lines/day | 15,000 | 30,000 | 50,000 |
| Concurrent users | — | 500 | 500 |

The 2x envelope is the sizing basis for staging and production. The load-test
target is the throughput the production environment must absorb during a
performance test.

## Derived volume at the 2x envelope

| Table / stream | Assumption | Rows/day | Rows/year |
|---|---|---|---|
| `sales.order_line` | 10 lines per order | 30,000 | 11.0M |
| `inventory.*` movements | ~2 movements per line | 60,000 | 21.9M |
| Domain mutations (idempotency-keyed commands) | ~5 per order, ~2 per line | 75,000 | 27.4M |
| `platform.outbox_event` | ~1 event per mutation | 75,000 | 27.4M |
| `audit.audit_entry` | ~3 audit rows per mutation (AGT §14) | 225,000 | 82.1M |
| `platform.idempotency_key` | 1 per command, 7-day retention | 75,000 | transient |

**The audit table dominates by a factor of three.** AGENTS.md §14 makes audit
mandatory for state mutation, and the WMS/POS flows that mutate stock write
several audit rows per line. Every other stream is an order of magnitude smaller.

Two of these assumptions are not yet confirmed by a business owner and are
recorded as such:

- **Audit rows per mutation = 3.** Unmeasured. `docs/IMPLEMENTATION_STATUS.md`
  still lists audit partition and retention as open work.
- **Inventory movements per line = 2.** Unmeasured for the real pick/putaway and
  cycle-count cadence.

If the audit multiplier turns out to be 6 rather than 3, the 3-year projection
below doubles. Confirm before production `terraform apply`.

## Storage projection (3-year horizon)

| Stream | Bytes/row incl. index | 3-year total |
|---|---|---|
| `audit.audit_entry` | ~700 B | ~172 GB |
| `inventory.*` movements | ~250 B | ~16 GB |
| `platform.outbox_event` | ~400 B | ~33 GB |
| `sales.order_line` | ~300 B | ~10 GB |
| **Total** | | **~231 GB** |

**`audit.audit_entry` needs range partitioning by month before it can hold a
three-year horizon.** Unpartitioned, autovacuum and index maintenance degrade
linearly and the 100k-active-item exception-queue query evidence in F0-03 becomes
unreliable. Partitioning is a schema change owned by the audit domain and is
tracked separately from this stack; it is a **prerequisite for production**, not
a follow-up.

Disk is provisioned at 500 GB with autoscaling bounded at 1,000 GB so that a
runaway cannot bill without limit.

## Compute sizing

Concurrency arithmetic for the request-serving services:

```
500 concurrent users / 80 per instance = 6.25 -> 7 warm instances at ceiling
```

Sizing is set for headroom above the concurrent-user figure rather than equal to
it, because mobile clients reconnect and a partially-completed POS checkout is
more expensive than a completed one:

| Service | min | max | concurrency | CPU / memory |
|---|---|---|---|---|
| `api` | 0 | 12 | 80 | 1000m / 512Mi |
| `finance-api` | 0 | 4 | 80 | 1000m / 512Mi |
| `geo-service` | 0 | 4 | 80 | 1000m / 512Mi |
| `web` | 0 | 8 | 80 | 1000m / 512Mi |
| `integration-worker` | **1** | 4 | 80 | 1000m / 512Mi |
| `keycloak` | **1** | 4 | 100 | 1000m / 2Gi |

`integration-worker` has `min_instance_count = 1` as a **validated invariant**,
not a default. The worker is a BullMQ poller; if it scales to zero it stops
draining `platform.outbox_event` and undelivered events accumulate with no
user-visible symptom. The root module rejects `worker_min_instances < 1`.

`keycloak` is also always on for the same class of reason: a scaled-to-zero IdP
breaks the login flow that every authenticated request depends on.

## Cache sizing

BullMQ's Redis holds in-flight and delayed jobs, **not** business-day volume. It
follows peak queue depth, not rows/day. At the 2x envelope the estimate is low
hundreds of queued jobs, so `STANDARD_1` (1 GB) with a replica is comfortable.
`maxmemory-policy` is pinned to `noeviction` because evicting a delayed job would
drop an event without a trace — the AGENTS.md §3.7 failure mode.

## Expected cost shape

Not a quote; a shape for the budget alert.

Cloud Run's free tier is 180,000 vCPU-seconds/month. One continuously-allocated
vCPU costs ~2,592,000 vCPU-seconds/month, so **the free tier covers about 7% of a
single always-on vCPU**. The always-on floor is therefore three compute units:
the worker, Keycloak, and NAT.

| Component | Note | Free tier? |
|---|---|---|
| Cloud Run request-serving | Scales to zero outside business hours | Partly |
| Cloud Run worker + Keycloak | Always on | No |
| Cloud SQL (Postgres 17 + PostGIS) | No always-free tier | No |
| Memorystore for Valkey | No always-free tier | No |
| Cloud Storage | ~5 GB-month | Partly |
| NAT gateway | Charged per hour and per GB | No |

Indicative steady state at the 2x envelope is roughly **$150–$350/month**, not a
free tier. Google's new-account credit of $300 is a short bridge, not a plan.
`docs/releases/F0.md` still records OD-188 (RPO/RTO) as open, and the 35-day
backup retention above is a placeholder, not an approved value.

## Bootstrapping

The state bucket cannot be created by the stack that uses it. Create it once by
hand or with a throwaway bootstrap stack:

```bash
gcloud storage buckets create gs://pss-terraform-state-<project> \
  --project=<project> --location=ASIA --uniform-bucket-level-access

gcloud projects add-iam-policy-binding <project> \
  --member=serviceAccount:<terraform-sa> --role=roles/storage.objectAdmin
```

Then per environment:

```bash
cd infrastructure/terraform
terraform init \
  -backend-config="bucket=pss-terraform-state-<project>" \
  -backend-config="prefix=pss/dev"
terraform plan -var-file=envs/dev.tfvars
```

**No environment has been applied.** `gcloud auth` reports no credentialed
account in this workspace, so nothing here has been created and no cost has been
incurred. Treat this directory as reviewed-but-unapplied.

## Capacity review triggers

Re-run this arithmetic when any of these become true:

1. `audit.audit_entry` is partitioned and its real rows-per-mutation is measured.
2. Order lines/day exceed 30,000 sustained, or the load test exceeds 50,000.
3. Concurrent users exceed 500, or POS checkout abandonment becomes measurable.
4. The read replica is added — reporting queries currently contend with the
   operational instance.
