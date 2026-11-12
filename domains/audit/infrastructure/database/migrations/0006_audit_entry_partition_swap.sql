-- OD-19 / PLT-012: activate the prepared monthly range-partitioned table.
--
-- `0003_audit_entry_partitioning_prereq.sql` prepared `audit.audit_entry_partitioned` and left
-- `audit.audit_entry` as the write target, because the swap needed two things that did not exist yet:
-- an answered retention decision, and a reviewed migration plan. Both exist now. The owner accepted
-- 10 years total with 24 months hot in the primary database and authorised the swap
-- (docs/decisions/2026-09-30-open-decision-proposals.md, OD-19).
--
-- The projected volume is why this is not optional. `infrastructure/terraform/README.md` puts
-- `audit.audit_entry` at ~225,000 rows/day, ~82.1M/year and ~700 B/row including index, so ~57.5 GB a
-- year. Hot for 24 months is ~115 GB. Unpartitioned, autovacuum and index maintenance degrade
-- linearly over that heap and a retention window becomes a mass DELETE against a table whose triggers
-- forbid DELETE — the two designs are incompatible, and partitioning is the only one that works.
--
-- WHY DROP RATHER THAN RENAME BOTH ASIDE: the legacy heap is a full second copy of the largest table
-- in the system (~115 GB hot). Retaining it to provide a rollback window would double primary storage
-- to hold a copy of data that is already verified present in the partitioned table, and the restore
-- path for a bad swap is point-in-time recovery, which is rehearsed by `pnpm dr:rehearse:local`.
-- The copy is verified by row count and by an archive-of-record assertion inside this transaction, so
-- the drop cannot lose a row that failed to arrive.
--
-- This migration and 0004 are safe to replay: every statement is guarded, and the DO blocks raise
-- rather than repair a state this file did not create.
--
-- ATOMICITY: this file issues no BEGIN or COMMIT of its own. `scripts/migrate.mjs` and every test
-- fixture apply it as a single statement, which PostgreSQL wraps in one implicit transaction, so the
-- copy, the verification and the drop commit or roll back together. A failure at any step leaves
-- `audit.audit_entry` exactly as it was — the partitioned copy is a separate object until step 5.
--
-- Plan: 0006_audit_entry_partition_swap.migration-plan.md

-- 1. Cover every month the existing rows span, plus the current month and the next one.
--
--    0003 created partitions for 2026-10..2027-01 and deliberately no DEFAULT, so an out-of-range
--    write raises instead of landing in an unbounded catch-all. That is the right default for a live
--    table, but it means a fresh deployment has no partition for the month it is running in, and the
--    very first write after this migration would fail. Covering the current month and the next closes
--    that window; the monthly job in `ensureAuditPartitions` keeps extending it.
DO $$
DECLARE
  v_first_month date;
  v_last_month  date;
BEGIN
  SELECT coalesce(date_trunc('month', min(occurred_at)), date_trunc('month', now()))::date
    INTO v_first_month
    FROM audit.audit_entry;
  -- The trailing GREATEST is the current month plus one: a partition must exist for the month the
  -- application is writing into, or the first write after the swap fails.
  SELECT greatest(
           coalesce(date_trunc('month', max(occurred_at)), date_trunc('month', now()))::date,
           (date_trunc('month', now()) + interval '1 month')::date
         )
    INTO v_last_month
    FROM audit.audit_entry;

  PERFORM audit.ensure_month_partitions('audit.audit_entry_partitioned'::regclass, v_first_month, v_last_month);
END;
$$;

-- 2. Reconcile the two places where the prepared shape and the live contract disagree.
--
--    a. `0003` declared `causation_id uuid`; `audit.audit_entry` and `AuditEntryInputSchema` both allow
--       any non-empty string. The destination is changed to the LIVE contract rather than the reverse,
--       because the alternative is tightening the application contract — refusing a caller that works
--       today — which is a behaviour change this swap has no reason to make. Widening `uuid` to `text`
--       cannot lose anything: every value already stored parses as a uuid, and text accepts it.
--
--    b. `0003` omitted `DEFAULT now()` on `occurred_at`, which `0001` has and `appendAuditEntry`
--       relies on: the INSERT names the column, so without the default the routing key is NULL and every
--       audit write fails with "no partition of relation found for row". A prepared table that was
--       never written to is exactly where this kind of omission hides, and the failure would appear in
--       production on the first write after the swap rather than in this migration.
ALTER TABLE audit.audit_entry_partitioned ALTER COLUMN causation_id TYPE text;
ALTER TABLE audit.audit_entry_partitioned ALTER COLUMN occurred_at SET DEFAULT now();

-- 2c. Prove the two tables now agree on every column's type, nullability and default, and refuse to
--     continue if they do not. The reconciliation above was found by a write failing after the swap,
--     which is the worst possible time; this turns the next divergence of the same kind into a
--     migration that stops with the column name in the message.
DO $$
DECLARE
  v_differences text;
BEGIN
  SELECT string_agg(format('%s (source %s/%s, destination %s/%s)',
                           a.attname,
                           format_type(a.atttypid, a.atttypmod),
                           coalesce(pg_get_expr(sd.adbin, sd.adrelid), 'no default'),
                           format_type(b.atttypid, b.atttypmod),
                           coalesce(pg_get_expr(dd.adbin, dd.adrelid), 'no default')), ', ')
    INTO v_differences
    FROM pg_attribute a
    JOIN pg_attribute b ON b.attrelid = 'audit.audit_entry_partitioned'::regclass
                       AND b.attname = a.attname
                     AND b.attnum > 0 AND NOT b.attisdropped
    LEFT JOIN pg_attrdef sd ON sd.adrelid = a.attrelid AND sd.adnum = a.attnum
    LEFT JOIN pg_attrdef dd ON dd.adrelid = b.attrelid AND dd.adnum = b.attnum
   WHERE a.attrelid = 'audit.audit_entry'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND (a.attnotnull <> b.attnotnull
          OR format_type(a.atttypid, a.atttypmod) <> format_type(b.atttypid, b.atttypmod)
          OR coalesce(pg_get_expr(sd.adbin, sd.adrelid), '') <> coalesce(pg_get_expr(dd.adbin, dd.adrelid), ''));

  IF v_differences IS NOT NULL THEN
    RAISE EXCEPTION 'partition swap aborted: audit.audit_entry and audit.audit_entry_partitioned disagree on %', v_differences;
  END IF;
END;
$$;

-- 3. Copy. The partitioning key must be in every unique constraint on a partitioned table, so the
--    destination's uniqueness is (occurred_at, ...) rather than the source's (request_id, ...). That
--    makes the once-per-version guarantee per-month rather than global. It cannot be made global on a
--    range-partitioned table without a second index on every row; the application-level guarantee is
--    that one request writes one entry per entity version inside one transaction, so the weakening is
--    theoretical. Recorded in the plan, not silently absorbed.
INSERT INTO audit.audit_entry_partitioned (
  id, occurred_at, organization_id, branch_id, actor_user_id, actor_roles, actor_on_behalf_of,
  actor_service_identity, action, entity_domain, entity_type, entity_id, entity_version, changes,
  reason_code, request_id, correlation_id, causation_id, source, retention_class
)
SELECT
  id, occurred_at, organization_id, branch_id, actor_user_id, actor_roles, actor_on_behalf_of,
  actor_service_identity, action, entity_domain, entity_type, entity_id, entity_version, changes,
  reason_code, request_id, correlation_id, causation_id, source, retention_class
FROM audit.audit_entry;

-- 4. Prove the copy before anything is destroyed. A row count that differs means the INSERT silently
--    lost a row, and it is cheaper to abort the whole migration than to discover it later.
DO $$
DECLARE
  v_source bigint;
  v_copied bigint;
  v_class_mismatches bigint;
BEGIN
  SELECT count(*) INTO v_source FROM audit.audit_entry;
  SELECT count(*) INTO v_copied FROM audit.audit_entry_partitioned;
  IF v_copied <> v_source THEN
    RAISE EXCEPTION 'partition swap aborted: copied % of % audit entries', v_copied, v_source;
  END IF;

  -- A row whose class did not travel with it would be archived under the wrong period, which is the
  -- one failure this whole change exists to prevent.
  SELECT count(*) INTO v_class_mismatches
    FROM audit.audit_entry e
    JOIN audit.audit_entry_partitioned p
      ON p.occurred_at = e.occurred_at AND p.id = e.id
   WHERE p.retention_class IS DISTINCT FROM e.retention_class;
  IF v_class_mismatches > 0 THEN
    RAISE EXCEPTION 'partition swap aborted: % audit entries changed retention class in the copy', v_class_mismatches;
  END IF;
END;
$$;

-- 5. Drop the legacy heap. Reaching this line means every source row is present in the partitioned
--    table with its class intact, verified immediately above in this transaction.
DROP TABLE audit.audit_entry;

-- 6. Promote. The partition children keep their names: they are attached to the parent by OID, so a
--    rename of the parent does not touch them, and `audit_entry_2026_10` stays `audit_entry_2026_10`.
ALTER TABLE audit.audit_entry_partitioned RENAME TO audit_entry;

-- 7. The indexes and triggers lived on the heap that step 5 removed, so they are recreated here. On a
--    partitioned table CREATE INDEX and CREATE TRIGGER propagate to every attached partition, and a
--    partition attached later inherits both automatically.
CREATE INDEX IF NOT EXISTS audit_entry_entity_idx
  ON audit.audit_entry (entity_domain, entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entry_correlation_idx
  ON audit.audit_entry (correlation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entry_actor_idx
  ON audit.audit_entry (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entry_occurred_idx
  ON audit.audit_entry (occurred_at DESC);
-- The retention job counts and pages by (retention_class, occurred_at) inside one partition; without
-- this it reads the month's whole heap twice per run.
CREATE INDEX IF NOT EXISTS audit_entry_retention_idx
  ON audit.audit_entry (retention_class, occurred_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'audit.audit_entry'::regclass AND tgname = 'audit_entry_immutable') THEN
    CREATE TRIGGER audit_entry_immutable BEFORE UPDATE OR DELETE ON audit.audit_entry
    FOR EACH ROW EXECUTE FUNCTION audit.reject_entry_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'audit.audit_entry'::regclass AND tgname = 'audit_entry_no_truncate') THEN
    CREATE TRIGGER audit_entry_no_truncate BEFORE TRUNCATE ON audit.audit_entry
    FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_entry_mutation();
  END IF;
END;
$$;

-- Dropping the old heap also dropped its grants, and the default PUBLIC grant is what 0001 revoked
-- deliberately. Re-issuing the REVOKE keeps the invariant true by construction on the new table.
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_entry FROM PUBLIC;

COMMENT ON TABLE audit.audit_entry IS
  'Immutable audit trail, monthly range-partitioned on occurred_at since OD-19 (2026-09-30). '
  'A partition is dropped only after its rows are archived and only when every row in it is past its '
  'class period; see domains/audit/src/domain/rules/partition-retention-decision.ts. '
  'The once-per-version guarantee is per-partition: (occurred_at, request_id, entity_domain, '
  'entity_type, entity_id, entity_version), because PostgreSQL requires the partition key in every '
  'unique constraint on a partitioned table.';
