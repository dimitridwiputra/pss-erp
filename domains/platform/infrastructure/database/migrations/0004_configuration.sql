CREATE TABLE IF NOT EXISTS platform.config_value (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  organization_id uuid,
  branch_id uuid,
  principal_id uuid,
  customer_id uuid,
  value jsonb,
  valid_from date NOT NULL,
  valid_to date,
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'SUPERSEDED')),
  proposed_by uuid NOT NULL,
  approved_by uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS config_value_lookup_idx
  ON platform.config_value(key, organization_id, valid_from DESC)
  WHERE status IN ('SCHEDULED', 'ACTIVE');

CREATE TABLE IF NOT EXISTS platform.feature_flag (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  targeting jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner text NOT NULL,
  target_remove_date date,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(targeting) = 'object')
);
CREATE INDEX IF NOT EXISTS feature_flag_remove_date_idx
  ON platform.feature_flag(target_remove_date)
  WHERE target_remove_date IS NOT NULL;
