-- WMS-013: one immutable reconciliation result per (warehouse, business_date). Idempotent by the
-- unique constraint below — a second run for the same date is a no-op that returns the original.
CREATE TABLE IF NOT EXISTS wms.reconciliation_result (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  business_date date NOT NULL,
  variance_count integer NOT NULL,
  items jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, business_date)
);

-- WMS-012: a physical unit (pallet/carton/koli) and the QR label printed for it or for a
-- location. `payload` is opaque (type + id only, per WMS-012.BR01 — never business data).
CREATE TABLE IF NOT EXISTS wms.warehouse_unit (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  unit_type text NOT NULL CHECK (unit_type IN ('PALLET', 'CARTON', 'PACKAGE')),
  code text NOT NULL,
  reference_type text,
  reference_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS warehouse_unit_reference_idx ON wms.warehouse_unit (reference_type, reference_id);

CREATE TABLE IF NOT EXISTS wms.warehouse_unit_line (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES wms.warehouse_unit (id),
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty numeric(18,3) NOT NULL CHECK (qty > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warehouse_unit_line_unit_idx ON wms.warehouse_unit_line (unit_id);

CREATE TABLE IF NOT EXISTS wms.label_print (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('LOCATION', 'UNIT')),
  subject_id uuid NOT NULL,
  copy_number integer NOT NULL CHECK (copy_number > 0),
  printed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS label_print_subject_idx ON wms.label_print (subject_type, subject_id);
