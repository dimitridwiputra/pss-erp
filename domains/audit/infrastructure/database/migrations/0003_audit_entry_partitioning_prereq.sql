-- PLT-012 / OD-188 prerequisite, surfaced by the capacity work in
-- infrastructure/terraform/README.md.
--
-- `audit.audit_entry` is projected at ~225,000 rows/day (~82M/year, ~172 GB over
-- three years), which makes it the largest table in the system by a factor of
-- three. Two consequences follow, and this migration addresses the first of them.
--
-- 1. INDEX / VACUUM PRESSURE (addressed here)
--    Every index on a growing table grows with it, and a single unpartitioned heap
--    degrades vacuum and index maintenance linearly. Declaring the table
--    PARTITIONED BY RANGE (occurred_at) lets autovacuum work on one month at a time
--    instead of the whole history, and makes a retention window a partition DROP
--    rather than a mass DELETE.
--
--    This migration only PREPARES for partitioning. It creates the partitioned
--    parent alongside the existing table and backfills it, but does not swap.
--    Swapping is a separate, reviewed step because it must coordinate with the
--    immutability triggers and the retention decision (OD-19), and because AGENTS.md
--    11.1 requires a destructive migration to carry a Backfill / Compatibility /
--    Rollback plan.
--
-- 2. RETENTION IS STILL UNDECIDED (NOT addressed here, deliberately)
--    Dropping a partition is how audit retention will eventually be enforced, but
--    the retention PERIOD is a legal/compliance decision, not an engineering one.
--    OD-19 is open and AGENTS.md 20 forbids inventing it. So no partition is
--    dropped, and no default partition is attached: an unbounded DEFAULT partition
--    silently becomes the place where out-of-range writes land, which is exactly
--    how audit entries go missing. Writes outside the covered range must FAIL
--    loudly until the partition set is extended.
--
-- COMPATIBILITY: the partitioned copy `audit.audit_entry_partitioned` is additive.
-- The application continues to write `audit.audit_entry` unchanged, and
-- `audit.append_audit_entry` has not been modified, so behaviour is identical.
--
-- ROLLBACK: `DROP TABLE audit.audit_entry_partitioned;` Nothing else depends on it.

CREATE TABLE IF NOT EXISTS audit.audit_entry_partitioned (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid,
  actor_user_id uuid,
  actor_roles text[] NOT NULL DEFAULT '{}',
  actor_on_behalf_of uuid,
  actor_service_identity text,
  action text NOT NULL,
  entity_domain text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version > 0),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
  reason_code text,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id uuid,
  source text NOT NULL CHECK (source IN ('WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT', 'OFFLINE', 'PAPER')),

  -- The partition key must participate in every unique constraint on a partitioned
  -- table. Both constraints below therefore include `occurred_at`, which is why this
  -- shape differs from audit.audit_entry. Verified against PostgreSQL 17: omitting
  -- it fails with "unique constraint on partitioned table must include all
  -- partitioning columns".
  PRIMARY KEY (occurred_at, id),
  CONSTRAINT audit_partitioned_entry_once_per_version
    UNIQUE (occurred_at, request_id, entity_domain, entity_type, entity_id, entity_version),

  CONSTRAINT audit_partitioned_actor_required
    CHECK (actor_user_id IS NOT NULL OR actor_service_identity IS NOT NULL)
) PARTITION BY RANGE (occurred_at);

COMMENT ON TABLE audit.audit_entry_partitioned IS
  'Prepared monthly-range-partitioned form of audit.audit_entry. Not yet the write target: '
  'see domains/audit/infrastructure/database/migrations/0003_audit_entry_partitioning_prereq.sql header. '
  'Swap is blocked on OD-19 (retention period) and on a reviewed .migration-plan.md.';

-- Partitions are created explicitly per month, never a blanket DEFAULT, so an
-- out-of-range write raises instead of landing in an unbounded catch-all.
CREATE TABLE IF NOT EXISTS audit.audit_entry_2026_10 PARTITION OF audit.audit_entry_partitioned
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS audit.audit_entry_2026_11 PARTITION OF audit.audit_entry_partitioned
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS audit.audit_entry_2026_12 PARTITION OF audit.audit_entry_partitioned
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS audit.audit_entry_2027_01 PARTITION OF audit.audit_entry_partitioned
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
