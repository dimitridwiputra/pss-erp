CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE IF NOT EXISTS sales.invoice_number_sequence (
  organization_id uuid NOT NULL,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, year)
);

CREATE TABLE IF NOT EXISTS sales.invoice (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  number text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PREPARED', 'ISSUED', 'CANCELLED')),
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  tax_total numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  invoice_date date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX IF NOT EXISTS invoice_order_idx ON sales.invoice (sales_order_id);

CREATE TABLE IF NOT EXISTS sales.invoice_line (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES sales.invoice (id),
  product_id uuid NOT NULL,
  uom text NOT NULL,
  qty numeric(18,3) NOT NULL CHECK (qty > 0),
  unit_price numeric(18,2) NOT NULL,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  line_total numeric(18,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_line_invoice_idx ON sales.invoice_line (invoice_id);
