CREATE TABLE IF NOT EXISTS platform.idempotency_key (
  organization_id uuid NOT NULL,
  identity_id text NOT NULL,
  command_name text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_code integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (organization_id, identity_id, command_name, idempotency_key),
  CONSTRAINT idempotency_response_state CHECK (
    (status = 'IN_PROGRESS' AND response_code IS NULL AND response_body IS NULL)
    OR (status = 'COMPLETED' AND response_code BETWEEN 100 AND 599 AND response_body IS NOT NULL)
  ),
  CONSTRAINT idempotency_min_retention CHECK (expires_at >= created_at + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idempotency_key_expiry_idx
  ON platform.idempotency_key (expires_at);
