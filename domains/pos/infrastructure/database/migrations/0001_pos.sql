CREATE SCHEMA IF NOT EXISTS pos;

CREATE TABLE IF NOT EXISTS pos.pos_terminal (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  device_id uuid,
  printer_profile jsonb,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS pos_terminal_warehouse_idx ON pos.pos_terminal (warehouse_id, status);

CREATE TABLE IF NOT EXISTS pos.pos_shift (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  terminal_id uuid NOT NULL REFERENCES pos.pos_terminal (id),
  cashier_user_id uuid NOT NULL,
  opening_float numeric(18,2) NOT NULL CHECK (opening_float >= 0),
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'CLOSED_WITH_DISCREPANCY', 'HANDED_OVER')),
  expected_cash numeric(18,2),
  counted_cash numeric(18,2),
  variance numeric(18,2),
  denominations jsonb,
  reason_code text,
  forced_close boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  handed_over_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- POS-000.R08: at most one OPEN shift per terminal, and per cashier
CREATE UNIQUE INDEX IF NOT EXISTS pos_shift_open_terminal_idx ON pos.pos_shift (terminal_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS pos_shift_open_cashier_idx ON pos.pos_shift (cashier_user_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS pos.pos_sale (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  terminal_id uuid NOT NULL REFERENCES pos.pos_terminal (id),
  shift_id uuid NOT NULL REFERENCES pos.pos_shift (id),
  number text,
  status text NOT NULL CHECK (status IN ('CART', 'PENDING_PAYMENT', 'PAID', 'CREDIT_APPROVED', 'HANDED_OVER', 'CANCELLED')),
  customer_id uuid,
  walk_in_name text,
  walk_in_phone text,
  sales_order_id uuid,
  fulfillment_request_id uuid,
  delivery_order_id uuid,
  invoice_id uuid,
  invoice_number text,
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  tax_total numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  cancel_reason_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_out_at timestamptz,
  paid_at timestamptz,
  handed_over_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX IF NOT EXISTS pos_sale_shift_idx ON pos.pos_sale (shift_id, status);
CREATE INDEX IF NOT EXISTS pos_sale_delivery_order_idx ON pos.pos_sale (delivery_order_id);

CREATE TABLE IF NOT EXISTS pos.pos_sale_line (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES pos.pos_sale (id),
  product_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  uom text NOT NULL,
  qty numeric(18,3) NOT NULL CHECK (qty > 0),
  unit_price numeric(18,2) NOT NULL,
  line_total numeric(18,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_sale_line_sale_idx ON pos.pos_sale_line (sale_id);

CREATE TABLE IF NOT EXISTS pos.pos_tender (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES pos.pos_sale (id),
  method text NOT NULL CHECK (method IN ('TUNAI', 'QRIS', 'TRANSFER')),
  status text NOT NULL CHECK (status IN ('ACCEPTED', 'PENDING_CONFIRMATION', 'VOIDED')),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  cash_received numeric(18,2),
  change_amount numeric(18,2),
  reference text,
  payment_id uuid,
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_reason text
);
CREATE INDEX IF NOT EXISTS pos_tender_sale_idx ON pos.pos_tender (sale_id);

CREATE TABLE IF NOT EXISTS pos.pos_receipt_print (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES pos.pos_sale (id),
  copy_number integer NOT NULL CHECK (copy_number > 0),
  printed_by uuid NOT NULL,
  printed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX IF NOT EXISTS pos_receipt_print_sale_idx ON pos.pos_receipt_print (sale_id);

CREATE TABLE IF NOT EXISTS pos.pos_offline_batch (
  id uuid PRIMARY KEY,
  terminal_id uuid NOT NULL REFERENCES pos.pos_terminal (id),
  status text NOT NULL CHECK (status IN ('RECEIVED', 'APPLIED', 'APPLIED_WITH_CONFLICTS')),
  payload jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS pos_offline_batch_terminal_idx ON pos.pos_offline_batch (terminal_id);
