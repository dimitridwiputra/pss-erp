CREATE SCHEMA IF NOT EXISTS audit;

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
