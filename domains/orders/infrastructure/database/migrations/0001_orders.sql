CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE IF NOT EXISTS sales.sales_order (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_source text NOT NULL,
  source_application text NOT NULL,
  handover_mode text NOT NULL CHECK (handover_mode IN ('DELIVERY', 'CUSTOMER_PICKUP')),
  status text NOT NULL CHECK (status IN ('REQUESTED', 'VALIDATED', 'CONFIRMED', 'IN_FULFILLMENT', 'COMPLETED', 'CANCELLED', 'REJECTED')),
  client_key text NOT NULL,
  total numeric(18,2) NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, client_key)
);
CREATE INDEX IF NOT EXISTS sales_order_organization_idx ON sales.sales_order (organization_id, status);

CREATE TABLE IF NOT EXISTS sales.sales_order_line (
  id uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL REFERENCES sales.sales_order (id),
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty numeric(18,3) NOT NULL CHECK (qty > 0),
  unit_price numeric(18,2) NOT NULL,
  line_total numeric(18,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_order_line_order_idx ON sales.sales_order_line (sales_order_id);
