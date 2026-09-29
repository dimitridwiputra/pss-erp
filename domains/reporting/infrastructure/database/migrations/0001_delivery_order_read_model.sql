CREATE SCHEMA IF NOT EXISTS reporting;

CREATE TABLE IF NOT EXISTS reporting.inbox_event (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE IF NOT EXISTS reporting.delivery_order_status (
  delivery_order_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  status text NOT NULL CHECK (status = 'DELIVERED'),
  delivered_at timestamptz NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  source_event_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS delivery_order_status_org_idx
  ON reporting.delivery_order_status (organization_id, delivered_at DESC);
