CREATE TABLE IF NOT EXISTS identity.role_assignment (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.user_account(id),
  role_code text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN (
    'ORGANIZATION', 'BRANCH', 'WAREHOUSE', 'TERRITORY',
    'PRINCIPAL', 'CUSTOMER', 'SALES_TEAM', 'OWN'
  )),
  scope_id uuid,
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_assignment_scope_id_check CHECK (
    (scope_type = 'OWN' AND scope_id IS NULL) OR
    (scope_type <> 'OWN' AND scope_id IS NOT NULL)
  ),
  CONSTRAINT role_assignment_time_check CHECK (expires_at IS NULL OR expires_at > effective_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS role_assignment_active_unique_idx
  ON identity.role_assignment (user_id, role_code, scope_type, scope_id)
  NULLS NOT DISTINCT WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS role_assignment_user_active_idx
  ON identity.role_assignment (user_id, effective_at, expires_at)
  WHERE revoked_at IS NULL;
