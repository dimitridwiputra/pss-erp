-- OD-19 audit retention: 10 years total, 24 months hot in the primary database.
--
-- This migration covers the two shapes the `retention_class` column has to exist on:
--
--   1. `audit.audit_entry` in a database that applied `0001_audit_entry.sql` before the column was
--      added to it. `ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT` backfills existing rows with the
--      default in one pass and is a no-op where the column already exists, so replaying the ordered
--      migration list is safe in either direction.
--   2. `audit.audit_entry_partitioned`, prepared by 0003, which 0006 promotes to the live table. It
--      needs the column before the backfill, or the copy would silently drop the class of every row
--      already written.
--
-- The CHECK constraints are added through a catalog-guarded DO block because PostgreSQL has no
-- `ADD CONSTRAINT IF NOT EXISTS`, and a migration that fails on a second run is not forward-only in
-- any useful sense.
--
-- Nothing here is destructive. The swap that promotes the partitioned table is `0006`, which carries
-- its own Backfill / Compatibility / Rollback plan.

-- `ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT` is a single catalog change plus a backfill of the
-- default in PostgreSQL 11 and later, not a table rewrite. It is a no-op where 0001 already created
-- the column, which is the whole point: the ordered list must run cleanly on a database created today
-- and on one that applied 0001 before the column was added to it.
ALTER TABLE audit.audit_entry
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'BUSINESS';
ALTER TABLE audit.audit_entry_partitioned
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'BUSINESS';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'audit.audit_entry'::regclass
       AND conname = 'audit_entry_retention_class_check') THEN
    ALTER TABLE audit.audit_entry ADD CONSTRAINT audit_entry_retention_class_check
      CHECK (retention_class IN ('FINANCIAL', 'BUSINESS', 'SECURITY', 'RAW_LANDING'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'audit.audit_entry_partitioned'::regclass
       AND conname = 'audit_partitioned_retention_class_check') THEN
    ALTER TABLE audit.audit_entry_partitioned ADD CONSTRAINT audit_partitioned_retention_class_check
      CHECK (retention_class IN ('FINANCIAL', 'BUSINESS', 'SECURITY', 'RAW_LANDING'));
  END IF;
END;
$$;

COMMENT ON COLUMN audit.audit_entry.retention_class IS
  'OD-19 retention class. SEC-001 classification INTERNAL: a policy label, not personal data. '
  'The period for each class is configuration, not schema, so changing it is a data write.';
COMMENT ON COLUMN audit.audit_entry_partitioned.retention_class IS
  'OD-19 retention class; promoted to the live table by 0006. See audit.audit_entry.retention_class.';
