-- DOC-001: document numbering per (document type, scope, business period).
--
-- Schema note: `check-database.mjs` maps logical schemas to owning domains and does not
-- list a `documents` schema, so `platform` cannot create `documents.*` (DB.R01). The tables
-- therefore live in `platform` alongside the other Platform-owned configuration, matching
-- the PRD's "WRITE AUTHORITY: `platform.documents`".
--
-- Counter note: DOC-001.TS04 requires {used} + {VOID} to be a continuous range for
-- `NO_GAP_FISCAL` types, and the main flow requires a rolled-back domain transaction to roll
-- the reservation back. A native PostgreSQL SEQUENCE is non-transactional, so it would burn
-- a number on rollback and create an unexplainable gap. This uses a locked counter row
-- (`SELECT ... FOR UPDATE` then `UPDATE ... RETURNING`) instead: the counter increment and
-- the reservation row commit together, and a void never returns a number to the pool.
--
-- Format note (GAP-16, open decision): the numbering pattern, the padding length, the gap
-- policy per document type, and the official branch code are NOT approved. `pattern`,
-- `branch_code`, and `gap_policy` are therefore nullable and stay NULL until Finance/Tax
-- validate them. `ReserveNumber` returns the allocated sequence value and its provenance and
-- reports `formattedNumber` as UNSET until an approved pattern exists; it never invents one.

CREATE TABLE IF NOT EXISTS platform.document_numbering_scheme (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  -- NULL means an organization-level document type (DOC-001.A2, e.g. a journal voucher).
  branch_id uuid,
  doc_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED')),
  -- Unapproved until GAP-16 closes. NULL is a valid, unconfigured state.
  pattern text,
  branch_code text,
  reset_policy text CHECK (reset_policy IS NULL OR reset_policy IN ('YEARLY', 'MONTHLY', 'NEVER')),
  gap_policy text CHECK (gap_policy IS NULL OR gap_policy IN ('NO_GAP_FISCAL', 'GAP_ALLOWED')),
  padding integer CHECK (padding IS NULL OR padding BETWEEN 1 AND 20),
  start_at bigint NOT NULL DEFAULT 1 CHECK (start_at >= 1),
  valid_from date NOT NULL,
  valid_to date,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- DOC-001.BR06: pattern changes are effective-dated; a scheme cannot be reopened once closed.
  CHECK (status = 'SUPERSEDED' OR valid_to IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS document_numbering_scheme_scope_idx
  ON platform.document_numbering_scheme (
    organization_id,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    doc_type,
    valid_from
  );

CREATE INDEX IF NOT EXISTS document_numbering_scheme_effective_idx
  ON platform.document_numbering_scheme (organization_id, doc_type, valid_from DESC)
  WHERE status = 'ACTIVE';

-- The locked counter. One row per (scheme, business period); `sequence_value` only ever moves forward.
CREATE TABLE IF NOT EXISTS platform.document_number_sequence (
  id uuid PRIMARY KEY,
  scheme_id uuid NOT NULL REFERENCES platform.document_numbering_scheme(id),
  -- 'Y:<YYYY>' | 'M:<YYYY>-<MM>' | 'A' for a NEVER-reset scheme.
  period_key text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scheme_id, period_key)
);

CREATE TABLE IF NOT EXISTS platform.document_number_reservation (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid,
  scheme_id uuid NOT NULL REFERENCES platform.document_numbering_scheme(id),
  doc_type text NOT NULL,
  -- DOC-001.BR05 / AC04: the sequence period comes from the document's own Asia/Jakarta
  -- business date, never the server date.
  document_date date NOT NULL,
  business_year integer NOT NULL CHECK (business_year BETWEEN 2000 AND 2999),
  business_month integer CHECK (business_month IS NULL OR business_month BETWEEN 1 AND 12),
  period_key text NOT NULL,
  sequence_value bigint NOT NULL CHECK (sequence_value >= 1),
  -- NULL until GAP-16 approves a pattern and the branch code is known.
  formatted_number text,
  -- DOC-001.R02: the caller's requestKey makes a retry return the same number.
  request_key text NOT NULL,
  requesting_domain text NOT NULL,
  reserved_by uuid,
  status text NOT NULL CHECK (status IN ('RESERVED', 'CONFIRMED', 'VOID')),
  document_id text,
  void_reason text,
  voided_by uuid,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- DOC-001.BR02: a number is never deleted, so CONFIRMED and VOID are both terminal.
  CHECK (status <> 'VOID' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL))
);

-- DOC-001.BR01: one (type, number) pair, ever. Holds for VOID rows too, which is what makes
-- DOC-001.NC02 (a voided number is never reissued) a database guarantee rather than a hope.
CREATE UNIQUE INDEX IF NOT EXISTS document_number_reservation_number_idx
  ON platform.document_number_reservation (
    organization_id,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    doc_type,
    period_key,
    sequence_value
  );

CREATE UNIQUE INDEX IF NOT EXISTS document_number_reservation_request_key_idx
  ON platform.document_number_reservation (
    organization_id,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    doc_type,
    request_key
  );

CREATE INDEX IF NOT EXISTS document_number_reservation_report_idx
  ON platform.document_number_reservation (organization_id, doc_type, period_key, sequence_value);
