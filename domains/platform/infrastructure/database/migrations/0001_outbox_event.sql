CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.outbox_event (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_event_pending_idx
  ON platform.outbox_event (created_at, event_id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_event_aggregate_idx
  ON platform.outbox_event (aggregate_type, aggregate_id, aggregate_version, created_at, event_id);
