CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE IF NOT EXISTS inventory.stock_balance (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty_on_hand numeric(18,3) NOT NULL DEFAULT 0,
  qty_reserved numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, product_id),
  CHECK (qty_reserved <= qty_on_hand)
);

CREATE TABLE IF NOT EXISTS inventory.stock_reservation (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty numeric(18,3) NOT NULL CHECK (qty > 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (reference_type, reference_id, product_id)
);
CREATE INDEX IF NOT EXISTS stock_reservation_reference_idx ON inventory.stock_reservation (reference_type, reference_id);

CREATE TABLE IF NOT EXISTS inventory.stock_movement (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty numeric(18,3) NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('ISSUE', 'ADJUSTMENT')),
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movement_reference_idx ON inventory.stock_movement (reference_type, reference_id);
