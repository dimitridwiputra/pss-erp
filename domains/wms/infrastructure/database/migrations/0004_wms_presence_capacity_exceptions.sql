-- WMS-015 dashboard extensions: real (not fabricated) operator presence, location capacity, and
-- an exception queue unifying the operational problems already thrown elsewhere in this domain
-- (scan mismatches, short allocations, invalid scanned locations, damaged goods, count variance)
-- into one reviewable list, matching the "Hambatan Gudang" / "Hambatan & Exception Gudang" panels.

-- One row per (warehouse, user): "online" is simply "seen recently" via an explicit heartbeat call
-- from the handheld/desktop client — this is a real, if minimal, presence signal, not a guess
-- derived from unrelated task timestamps.
CREATE TABLE IF NOT EXISTS wms.operator_session (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  user_id uuid NOT NULL,
  current_task_id uuid REFERENCES wms.warehouse_task (id),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, user_id)
);

-- Capacity is opt-in (nullable): a location with no capacity recorded is simply excluded from
-- utilization-% reporting rather than reported as 0% or 100%.
ALTER TABLE wms.warehouse_location ADD COLUMN IF NOT EXISTS capacity_qty numeric(18,3) CHECK (capacity_qty IS NULL OR capacity_qty > 0);

CREATE TABLE IF NOT EXISTS wms.exception_queue (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  exception_type text NOT NULL CHECK (exception_type IN ('SCAN_MISMATCH', 'SHORT_ALLOCATION', 'INVALID_LOCATION', 'DAMAGED_GOODS', 'COUNT_VARIANCE')),
  reference_type text,
  reference_id uuid,
  severity text NOT NULL DEFAULT 'NORMAL' CHECK (severity IN ('LOW', 'NORMAL', 'HIGH')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
  description text,
  opened_by uuid,
  assigned_to uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS exception_queue_open_idx ON wms.exception_queue (warehouse_id, status);
