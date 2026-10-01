-- OD-19 archive lifecycle: a partition may only leave the hot table after its archive is VERIFIED.
--
-- `audit.audit_entry` is append-only and its UPDATE/DELETE are refused by trigger (DB.R05), so a
-- PostgreSQL partition DROP is the only mechanism that removes rows from the hot table. That makes
-- the archive the only other copy, and it makes a silently-failing archive a way to destroy audit
-- evidence without anyone deciding to. The owner's decision is that partition rotation must not run
-- in production until a restore drill has been proven, and that the drop waits on verification
-- rather than on the archive merely succeeding.
--
-- Two things this schema deliberately separates, because conflating them is how evidence gets
-- destroyed by accident:
--
--   HOT RESIDENCY      audit.hot_months. How long a row stays queryable in the primary database.
--   ARCHIVE DESTRUCTION audit.retention_years. How long the archived OBJECT is kept. KOSONG means
--                       INDEFINITE: no deletion job is scheduled, ever.
--
-- A partition can therefore be dropped from the hot database while its archive is retained forever.
-- Those are separate decisions and the schema keeps them in separate columns so that neither can be
-- derived from the other.
--
-- Forward-only. No existing table is altered; rolling this back drops these three tables and leaves
-- `audit.audit_entry` untouched.

-- ---------------------------------------------------------------------------
-- The artifact: one row per archived object.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.audit_archive_object (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,

  -- What was archived, and the bounds it covers. Bounds are the partition's own edges, not the
  -- rows' observed min/max, so a partition's range is known even if it held nothing.
  source_partition text NOT NULL,
  period_from date NOT NULL,
  period_through date NOT NULL,

  -- Where the bytes are. The bucket is the already-approved versioned/object-lock capable store
  -- (PLT-000.R95); object_lock is recorded so a reader can tell a protected artifact from a
  -- best-effort one rather than assuming.
  object_uri text NOT NULL,
  object_version_id text,
  object_lock_configured boolean NOT NULL DEFAULT false,

  -- The integrity material. `checksum_sha256` is over the canonical row digest defined in
  -- src/domain/audit-archive.ts, not over the object bytes, so it is reproducible by a restore
  -- without re-serialising the archive format.
  row_count integer NOT NULL CHECK (row_count >= 0),
  min_occurred_at timestamptz,
  max_occurred_at timestamptz,
  checksum_sha256 text NOT NULL,
  schema_version text NOT NULL,

  -- Hash-chain boundary. AUD-001 has no hash chain implemented, so these are nullable rather than
  -- invented: a chain that does not exist must not be recorded as one that verifies.
  hash_chain_first_entry_id uuid,
  hash_chain_last_entry_id uuid,

  -- Archive destruction, independent of hot residency. `mode = 'INDEFINITE'` with a NULL
  -- purge_after is the KOSONG case and is the reason this is a pair of columns rather than one
  -- date: the previous contract returned a Date for every page, which asserted that every archive
  -- must eventually be destroyed and left KOSONG with nowhere to go.
  retention_mode text NOT NULL CHECK (retention_mode IN ('INDEFINITE', 'PURGE_AFTER')),
  purge_after timestamptz,
  CONSTRAINT audit_archive_retention_pair_ck CHECK (
    (retention_mode = 'INDEFINITE' AND purge_after IS NULL)
    OR (retention_mode = 'PURGE_AFTER' AND purge_after IS NOT NULL)
  ),

  status text NOT NULL CHECK (status IN ('ARCHIVING', 'ARCHIVED', 'VERIFIED', 'FAILED', 'PURGED')),
  actor_service_identity text NOT NULL,
  job_request_id text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_archive_period_ck CHECK (period_through > period_from)
);

COMMENT ON TABLE audit.audit_archive_object IS
  'One row per archived audit partition artifact. Status VERIFIED is the precondition for dropping the hot partition.';
COMMENT ON COLUMN audit.audit_archive_object.retention_mode IS
  'INDEFINITE means audit.retention_years is KOSONG: this artifact is never deleted. Independent of audit.hot_months.';

CREATE INDEX IF NOT EXISTS audit_archive_object_partition_idx
  ON audit.audit_archive_object (source_partition, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_archive_object_status_idx
  ON audit.audit_archive_object (status) WHERE status IN ('ARCHIVING', 'ARCHIVED', 'FAILED');
-- The deletion scheduler reads only finite-retention rows, so an INDEFINITE artifact is not merely
-- skipped at runtime: it is never in the index the job scans.
CREATE INDEX IF NOT EXISTS audit_archive_object_purgeable_idx
  ON audit.audit_archive_object (purge_after)
  WHERE retention_mode = 'PURGE_AFTER' AND status = 'VERIFIED';

-- ---------------------------------------------------------------------------
-- The receipt: one row per archive attempt, including failures.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.audit_archive_receipt (
  id uuid PRIMARY KEY,
  archive_object_id uuid NOT NULL REFERENCES audit.audit_archive_object (id),
  cursor text NOT NULL,
  rows_acked integer NOT NULL CHECK (rows_acked >= 0),
  digest_acked text NOT NULL,
  archived_at timestamptz NOT NULL,
  service_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_archive_receipt_once_ck UNIQUE (archive_object_id, cursor)
);

COMMENT ON CONSTRAINT audit_archive_receipt_once_ck ON audit.audit_archive_receipt IS
  'A cursor may be acknowledged once per artifact, so a retry after a crash cannot double-count a page.';

-- ---------------------------------------------------------------------------
-- Restore verification: the evidence a drop depends on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.audit_restore_verification (
  id uuid PRIMARY KEY,
  archive_object_id uuid NOT NULL REFERENCES audit.audit_archive_object (id),
  status text NOT NULL CHECK (status IN ('VERIFIED', 'FAILED')),
  -- What the restore actually checked, in the isolated database it was restored into.
  restored_row_count integer CHECK (restored_row_count IS NULL OR restored_row_count >= 0),
  restored_checksum_sha256 text,
  restored_min_occurred_at timestamptz,
  restored_max_occurred_at timestamptz,
  -- A representative read, so "it loaded" is not mistaken for "it is queryable by the identifiers an
  -- auditor would actually search on.
  entity_probe_result text,
  scratch_database text,
  failure_reason text,
  verified_at timestamptz NOT NULL,
  operator_service_identity text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A verification that claims success must carry the evidence; otherwise 'VERIFIED' is a word
  -- rather than a finding, and a drop would be gated on a claim. A FAILED row needs no evidence,
  -- and `scratch_database` is nullable precisely because a failure may have no database to name.
  CONSTRAINT audit_restore_verification_evidence_ck CHECK (
    status = 'FAILED'
    OR (restored_row_count IS NOT NULL
        AND restored_checksum_sha256 IS NOT NULL
        AND restored_min_occurred_at IS NOT NULL
        AND restored_max_occurred_at IS NOT NULL)
  )
);

COMMENT ON TABLE audit.audit_restore_verification IS
  'Evidence that an archived artifact was restored into an isolated database and matched. A hot partition is dropped only against a VERIFIED row here.';

CREATE INDEX IF NOT EXISTS audit_restore_verification_object_idx
  ON audit.audit_restore_verification (archive_object_id, verified_at DESC);

-- ---------------------------------------------------------------------------
-- Partition lifecycle: the state a partition is actually in.
--
-- HOT -> ARCHIVING -> ARCHIVED_VERIFIED -> HOT_PARTITION_DROPPED
--
-- ARCHIVED and VERIFIED are separate because "the bytes were written" and "the bytes came back and
-- matched" are different facts, and only the second one justifies a drop.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.audit_partition_state (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  partition_name text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'HOT', 'ARCHIVING', 'ARCHIVED', 'ARCHIVED_VERIFIED', 'HOT_PARTITION_DROPPED', 'HELD')),
  archive_object_id uuid REFERENCES audit.audit_archive_object (id),
  hold_reason text,
  period_from date NOT NULL,
  period_through date NOT NULL,
  service_identity text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_partition_state_once_ck UNIQUE (organization_id, partition_name),
  -- A partition cannot be VERIFIED without the artifact it was verified against, nor HELD without
  -- a reason an operator can act on.
  CONSTRAINT audit_partition_state_evidence_ck CHECK (
    (state IN ('ARCHIVED', 'ARCHIVED_VERIFIED', 'HOT_PARTITION_DROPPED') AND archive_object_id IS NOT NULL)
    AND (state <> 'HELD' OR hold_reason IS NOT NULL)
  )
);

COMMENT ON TABLE audit.audit_partition_state IS
  'Lifecycle of each monthly audit partition. HOT_PARTITION_DROPPED is reachable only from ARCHIVED_VERIFIED, which requires a VERIFIED audit_restore_verification row.';

CREATE INDEX IF NOT EXISTS audit_partition_state_lifecycle_idx
  ON audit.audit_partition_state (state, period_through);
