-- AUD-ARCHIVE-06: the application role must not be able to drop an audit partition.
--
-- What I got wrong first, because it is the part that matters.
--
-- I wrote this migration on the reasoning that PostgreSQL grants EXECUTE on functions to PUBLIC by
-- default, so `audit.drop_month_partition(text)` being executable by PUBLIC was an escalation path.
-- Checked rather than assumed, it is not: the function is SECURITY INVOKER, so it runs as its caller,
-- and the `DROP TABLE` inside it already requires the caller to own the table. PUBLIC could call it
-- and would then be refused. Revoking EXECUTE from PUBLIC would have changed nothing and the
-- runbook would have claimed a control that was not there.
--
-- The actual exposure is the opposite one. Because the function is SECURITY INVOKER, the drop
-- authority is exactly table ownership — and the role that applies migrations owns every audit
-- table, because it created them. An application connecting with migration credentials could call
-- the function and destroy aged evidence without going anywhere near the archive-and-restore gate,
-- with nothing in `audit.audit_restore_verification` and nothing in `audit.audit_partition_state`.
-- The gate added for OD-19 was sound and was also bypassable. That is the honest description of it.
--
-- The fix is to make the function SECURITY DEFINER. It then performs the DROP as its owner, so the
-- privilege belongs to the function rather than to whoever happens to own the tables, and it can be
-- granted to exactly one role. `SET search_path` is pinned as a matter of course: a SECURITY DEFINER
-- function with an inherited search_path is the standard escalation shape, and although every object
-- in this function is already schema-qualified, pinning costs nothing and removes the question.
--
-- Roles are declared NOLOGIN and carry no password. Credentials belong to deployment, not to a
-- migration replayed in every environment including a developer's laptop; a secret written here
-- would be a secret in version control and in every fixture that replays this file.
--
-- The role that applies migrations keeps implicit ownership of everything it created, so nothing here
-- blocks the migration path. The invariant below is about the *application*, which is a different
-- thing from the migrator.

-- ---------------------------------------------------------------------------------------------
-- Group roles, granted to real login roles at deploy time. NOLOGIN is the point: these are
-- capabilities, not accounts.
-- ---------------------------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pss_app') THEN
    CREATE ROLE pss_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pss_maintenance') THEN
    CREATE ROLE pss_maintenance NOLOGIN;
  END IF;
END
$do$;

COMMENT ON ROLE pss_app IS
  'Application connections. May append audit entries and read the audit trail. Must not be able to drop an audit partition (AUD-ARCHIVE-06).';
COMMENT ON ROLE pss_maintenance IS
  'Operational maintenance jobs, including audit archive rotation. The only role granted audit.drop_month_partition.';

-- ---------------------------------------------------------------------------------------------
-- The invariant.
--
-- SECURITY DEFINER: the DROP is performed as this function's owner, so authority to destroy audit
-- evidence stops being a side effect of table ownership and becomes a grant that can be withheld.
-- Both input checks are kept — the name pattern and the parent-table check — because under SECURITY
-- DEFINER they are the only thing between a caller and a privileged DROP. The name pattern also
-- keeps every character fed to format('%I') inside a known alphabet, and %I quotes regardless.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.drop_month_partition(p_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $fn$
DECLARE
  v_parent regclass;
BEGIN
  IF p_name !~ '^audit_entry_[0-9]{4}_[0-9]{2}$' THEN
    RAISE EXCEPTION 'refusing to drop %: not a monthly audit partition name', p_name;
  END IF;

  SELECT i.inhparent INTO v_parent
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE c.oid = to_regclass(format('audit.%I', p_name));

  IF v_parent IS DISTINCT FROM 'audit.audit_entry'::regclass THEN
    RAISE EXCEPTION 'refusing to drop audit.%: it is not a partition of audit.audit_entry', p_name;
  END IF;

  EXECUTE format('DROP TABLE audit.%I', p_name);
  RETURN true;
END;
$fn$;

COMMENT ON FUNCTION audit.drop_month_partition(text) IS
  'Drops a monthly audit partition. SECURITY DEFINER so the privilege is a grant rather than a side effect of table ownership; executable only by pss_maintenance. Callers must still archive and verify the restore first.';

-- PUBLIC is revoked anyway. It was not the escalation path — SECURITY INVOKER already refused that —
-- but leaving a privileged DROP executable by PUBLIC after making it SECURITY DEFINER would create
-- the escalation that does not exist today.
REVOKE EXECUTE ON FUNCTION audit.drop_month_partition(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit.drop_month_partition(text) FROM pss_app;

GRANT EXECUTE ON FUNCTION audit.drop_month_partition(text) TO pss_maintenance;

-- Partition *creation* is not privileged. `ensure_month_partitions` runs on the write path — every
-- audit append provisions the month it is writing into — so an application that could not call it
-- would fail its first write of a new month with "no partition of relation found for row". It stays
-- SECURITY INVOKER: creating a partition needs ownership, which the application does not have, so
-- this grant is for a role that does, and it is deliberately not turned into a definer function.
GRANT EXECUTE ON FUNCTION audit.ensure_month_partitions(regclass, date, date) TO pss_app;
GRANT EXECUTE ON FUNCTION audit.ensure_month_partitions(regclass, date, date) TO pss_maintenance;

-- ---------------------------------------------------------------------------------------------
-- Schema USAGE first. Granting privileges on a table without granting USAGE on its schema achieves
-- nothing: PostgreSQL resolves an object through its schema, so `permission denied for schema audit`
-- is what a role with table grants and no schema grant actually gets. Found by trying it.
-- ---------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA audit TO pss_app;
GRANT USAGE ON SCHEMA audit TO pss_maintenance;

-- ---------------------------------------------------------------------------------------------
-- What the application needs from the audit schema.
--
-- Append and read only. The archive lifecycle tables belong to maintenance: an application able to
-- write a VERIFIED restore row would be able to unlock its own partition deletion without ever
-- restoring anything, which defeats the gate from the other direction.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON audit.audit_entry TO pss_app;

GRANT SELECT ON audit.audit_archive_object TO pss_app;
GRANT SELECT ON audit.audit_restore_verification TO pss_app;
GRANT SELECT ON audit.audit_partition_state TO pss_app;

GRANT SELECT, INSERT, UPDATE ON audit.audit_archive_object TO pss_maintenance;
GRANT SELECT, INSERT ON audit.audit_restore_verification TO pss_maintenance;
GRANT SELECT, INSERT, UPDATE ON audit.audit_partition_state TO pss_maintenance;
