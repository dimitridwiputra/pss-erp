CREATE SCHEMA IF NOT EXISTS audit;

-- ADDED AFTER 0001 FIRST SHIPPED, 2026-09-30 (OD-19): the `retention_class` column below.
--
-- The column is additive, has a default, and touches no existing column, so re-running this file
-- against a database that already applied the pre-amendment version is a complete no-op — every
-- statement here is already guarded by IF NOT EXISTS. A database that applied the old 0001 gets the
-- column from `0004_audit_entry_retention_class.sql`, which adds it `IF NOT EXISTS`; a database
-- created after this amendment gets it from the CREATE TABLE. The reason the column lives in 0001 as
-- well as 0004 is that nineteen test fixtures across eleven domains replay this file alone, and
-- `appendAuditEntry` names the column in its INSERT. The proper fix is for those fixtures to replay
-- the whole ordered list, which is a change outside the audit domain.
CREATE TABLE IF NOT EXISTS audit.audit_entry (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
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
  causation_id text,
  source text NOT NULL CHECK (source IN ('WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT')),
  -- OD-19: how long this row may stay in the primary database before it moves to cold archive.
  -- The default is the middle of the proposed class table, so a caller that forgets to classify
  -- over-retains rather than silently destroying a record. The PERIOD is not stored here on purpose:
  -- retention is configuration (see `audit.ensure_month_partitions` consumers and DOMAIN.md), so
  -- changing 24 months to 36 is a data write and never a migration. SEC-001 classification: INTERNAL.
  retention_class text NOT NULL DEFAULT 'BUSINESS',
  CONSTRAINT audit_entry_retention_class_check
    CHECK (retention_class IN ('FINANCIAL', 'BUSINESS', 'SECURITY', 'RAW_LANDING')),
  CONSTRAINT audit_actor_required CHECK (actor_user_id IS NOT NULL OR actor_service_identity IS NOT NULL),
  CONSTRAINT audit_entry_once_per_version UNIQUE (request_id, entity_domain, entity_type, entity_id, entity_version)
);

CREATE INDEX IF NOT EXISTS audit_entry_entity_idx ON audit.audit_entry (entity_domain, entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entry_correlation_idx ON audit.audit_entry (correlation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entry_actor_idx ON audit.audit_entry (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_entry_occurred_idx ON audit.audit_entry (occurred_at DESC);

CREATE OR REPLACE FUNCTION audit.reject_entry_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit entries are append-only';
END;
$$;

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

REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_entry FROM PUBLIC;
