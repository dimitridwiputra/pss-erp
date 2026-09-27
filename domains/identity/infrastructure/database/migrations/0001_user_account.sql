CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS identity.user_account (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  idp_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  employee_code text,
  primary_branch_id uuid,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_account_organization_idx
  ON identity.user_account (organization_id, status);
