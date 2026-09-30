-- The Finance subject/effect is separate from Platform's decision aggregate.
ALTER TABLE finance.journal ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE finance.journal ADD COLUMN IF NOT EXISTS approval_request_id uuid UNIQUE;
ALTER TABLE finance.journal ADD COLUMN IF NOT EXISTS late_posting boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS finance.approval_effect (
  request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  approval_type text NOT NULL,
  subject_type text NOT NULL,
  subject_ref text NOT NULL,
  subject_version integer NOT NULL CHECK (subject_version > 0),
  context_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','APPLIED','STALE','FAILED')),
  decision_event_id uuid UNIQUE,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_type, subject_ref, subject_version)
);

CREATE TABLE IF NOT EXISTS finance.period_reopen_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  period_id uuid NOT NULL REFERENCES finance.accounting_period(id),
  requested_by uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPLIED','REJECTED','STALE')),
  version integer NOT NULL DEFAULT 1,
  approval_request_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS period_reopen_one_pending_idx
  ON finance.period_reopen_request(period_id) WHERE status = 'PENDING_APPROVAL';

CREATE TABLE IF NOT EXISTS finance.period_close_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  period_id uuid NOT NULL REFERENCES finance.accounting_period(id),
  requested_by uuid NOT NULL,
  reason text NOT NULL,
  override_exceptions boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPLIED','REJECTED','STALE','FAILED')),
  version integer NOT NULL DEFAULT 1,
  approval_request_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS period_close_one_pending_idx
  ON finance.period_close_request(period_id) WHERE status = 'PENDING_APPROVAL';
