CREATE TABLE IF NOT EXISTS reporting.approval_status (
  approval_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid,
  type_code text NOT NULL,
  owner_domain text NOT NULL,
  subject_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  source_event_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_status_pending_idx
  ON reporting.approval_status (organization_id, branch_id, updated_at)
  WHERE status = 'PENDING';
