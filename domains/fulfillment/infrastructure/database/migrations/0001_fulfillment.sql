CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE IF NOT EXISTS sales.fulfillment_request (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('RELEASED', 'IN_PROGRESS', 'READY', 'SHIPPED', 'CLOSED_SHORT', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fulfillment_request_order_idx ON sales.fulfillment_request (sales_order_id);

CREATE TABLE IF NOT EXISTS sales.delivery_order (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  fulfillment_request_id uuid NOT NULL REFERENCES sales.fulfillment_request (id),
  handover_mode text NOT NULL CHECK (handover_mode IN ('DELIVERY', 'CUSTOMER_PICKUP')),
  status text NOT NULL CHECK (status IN ('PREPARED', 'DISPATCHED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'NOT_DELIVERED', 'CLOSED', 'CANCELLED')),
  receiver_name text,
  delivered_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_order_fr_idx ON sales.delivery_order (fulfillment_request_id);

CREATE TABLE IF NOT EXISTS sales.delivery_order_line (
  id uuid PRIMARY KEY,
  delivery_order_id uuid NOT NULL REFERENCES sales.delivery_order (id),
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty_ordered numeric(18,3) NOT NULL CHECK (qty_ordered > 0),
  qty_delivered numeric(18,3) NOT NULL DEFAULT 0,
  CHECK (qty_delivered <= qty_ordered)
);
CREATE INDEX IF NOT EXISTS delivery_order_line_do_idx ON sales.delivery_order_line (delivery_order_id);
