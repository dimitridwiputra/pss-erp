CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.customer (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  branch_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  phone text,
  npwp text,
  segment text,
  channel text,
  is_walk_in boolean NOT NULL DEFAULT false,
  credit_disabled boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'INACTIVE', 'MERGED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS customer_organization_idx ON core.customer (organization_id, status);
-- exactly one walk-in customer per branch
CREATE UNIQUE INDEX IF NOT EXISTS customer_walk_in_per_branch_idx ON core.customer (organization_id, branch_id) WHERE is_walk_in;

CREATE TABLE IF NOT EXISTS core.product (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  base_uom text NOT NULL,
  order_capture text NOT NULL DEFAULT 'PSS' CHECK (order_capture IN ('PSS', 'EXTERNAL')),
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);

CREATE TABLE IF NOT EXISTS core.product_uom (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES core.product (id),
  uom text NOT NULL,
  conversion_factor numeric(18,6) NOT NULL CHECK (conversion_factor > 0),
  is_base boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, uom)
);

CREATE TABLE IF NOT EXISTS core.product_barcode (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES core.product (id),
  uom text NOT NULL,
  barcode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (barcode)
);
CREATE INDEX IF NOT EXISTS product_organization_idx ON core.product (organization_id, status);
