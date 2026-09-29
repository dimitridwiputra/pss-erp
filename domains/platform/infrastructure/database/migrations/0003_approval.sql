CREATE TABLE IF NOT EXISTS platform.approval_type (
  code text PRIMARY KEY,
  owner_domain text NOT NULL,
  subject_type text NOT NULL,
  expiry_hours integer NOT NULL CHECK (expiry_hours BETWEEN 1 AND 720),
  delegation_allowed boolean NOT NULL DEFAULT false,
  reason_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.approval_policy (
  id uuid PRIMARY KEY,
  type_code text NOT NULL REFERENCES platform.approval_type(code),
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS approval_policy_effective_idx
  ON platform.approval_policy(type_code, effective_from DESC) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS platform.approval_level (
  policy_id uuid NOT NULL REFERENCES platform.approval_policy(id),
  level integer NOT NULL CHECK (level BETWEEN 1 AND 3),
  role_code text NOT NULL,
  permission_code text NOT NULL,
  max_amount numeric(20,2),
  PRIMARY KEY (policy_id, level),
  CHECK (max_amount IS NULL OR max_amount >= 0)
);

CREATE TABLE IF NOT EXISTS platform.approval_request (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid,
  type_code text NOT NULL REFERENCES platform.approval_type(code),
  policy_id uuid NOT NULL REFERENCES platform.approval_policy(id),
  owner_domain text NOT NULL,
  subject_ref text NOT NULL,
  requester_id uuid NOT NULL,
  amount numeric(20,2),
  summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  level integer NOT NULL,
  required_role text NOT NULL,
  permission_code text NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_request_pending_idx
  ON platform.approval_request(organization_id, required_role, branch_id, created_at)
  WHERE status = 'PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS approval_request_subject_pending_idx
  ON platform.approval_request(organization_id, type_code, owner_domain, subject_ref)
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS platform.approval_delegation (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid,
  type_code text NOT NULL REFERENCES platform.approval_type(code),
  delegator_id uuid NOT NULL,
  delegate_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (delegator_id <> delegate_id),
  CHECK (valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS approval_delegation_active_idx
  ON platform.approval_delegation(organization_id, delegate_id, type_code, valid_to)
  WHERE revoked_at IS NULL;
