CREATE SCHEMA IF NOT EXISTS wms;

-- WMS-002 (simplified): one row per warehouse recording whether physical execution has been
-- handed to PSS Gudang yet. No lot/condition dimension is tracked (see DOMAIN.md open decisions).
CREATE TABLE IF NOT EXISTS wms.warehouse_config (
  organization_id uuid NOT NULL,
  warehouse_id uuid PRIMARY KEY,
  wms_enabled boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- WMS-001: zone -> aisle -> rack -> bin hierarchy, plus the functional RECEIVING/STAGING/
-- QUARANTINE location types every other command in this slice needs a place to point at.
CREATE TABLE IF NOT EXISTS wms.warehouse_location (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  parent_location_id uuid REFERENCES wms.warehouse_location (id),
  type text NOT NULL CHECK (type IN ('ZONE', 'AISLE', 'RACK', 'BIN', 'RECEIVING', 'STAGING', 'QUARANTINE')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code)
);
CREATE INDEX IF NOT EXISTS warehouse_location_parent_idx ON wms.warehouse_location (parent_location_id);

-- WMS's own per-(location, product) physical quantity — distinct from `inventory.stock_balance`'s
-- per-warehouse financial quantity (DOMAIN.md "Does not own"). `qty_allocated` tracks stock a PICK
-- task already claims (WMS-005.BR02: never allocate the same physical unit to two tasks).
CREATE TABLE IF NOT EXISTS wms.physical_stock (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES wms.warehouse_location (id),
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty_on_hand numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  qty_allocated numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_allocated >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, product_id),
  CHECK (qty_allocated <= qty_on_hand)
);
CREATE INDEX IF NOT EXISTS physical_stock_warehouse_product_idx ON wms.physical_stock (warehouse_id, product_id);

-- Generic task table for every SCAN -> CONFIRM -> NEXT flow (WMS-000.R01/R02): RECEIVE, PUTAWAY,
-- PICK, COUNT. `reference_type`/`reference_id` are opaque to this domain (e.g. a fulfillment
-- request id for PICK) the same way `inventory.stock_movement`'s reference columns are.
CREATE TABLE IF NOT EXISTS wms.warehouse_task (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('RECEIVE', 'PUTAWAY', 'PICK', 'COUNT')),
  status text NOT NULL CHECK (status IN ('CREATED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_SHORT', 'CANCELLED')),
  reference_type text,
  reference_id uuid,
  location_id uuid REFERENCES wms.warehouse_location (id),
  to_location_id uuid REFERENCES wms.warehouse_location (id),
  product_id uuid,
  uom text,
  qty_expected numeric(18,3),
  qty_confirmed numeric(18,3),
  short_reason_code text,
  assignee_user_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warehouse_task_warehouse_status_idx ON wms.warehouse_task (warehouse_id, type, status);
CREATE INDEX IF NOT EXISTS warehouse_task_reference_idx ON wms.warehouse_task (reference_type, reference_id);

-- WMS-011: a physical exception (damage, missing, surplus, wrong location) reported from any
-- task. BR01: never changes the financial balance by itself — only `resolveStockDiscrepancy`
-- calling `inventory.adjustStock` does that, and only once ADJUSTED.
CREATE TABLE IF NOT EXISTS wms.stock_discrepancy_report (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES wms.warehouse_location (id),
  product_id uuid NOT NULL,
  uom text NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('DAMAGED', 'MISSING', 'EXCESS', 'WRONG_LOCATION')),
  qty numeric(18,3) NOT NULL CHECK (qty > 0),
  reason_code text NOT NULL,
  evidence_media_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED', 'ADJUSTED', 'REJECTED')),
  reported_by uuid,
  source_task_id uuid REFERENCES wms.warehouse_task (id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_discrepancy_report_status_idx ON wms.stock_discrepancy_report (warehouse_id, status);
