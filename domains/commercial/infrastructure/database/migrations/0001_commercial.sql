CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.price_list (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'EXPIRED')),
  valid_from date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- at most one ACTIVE price list per (organization, scope)
CREATE UNIQUE INDEX IF NOT EXISTS price_list_active_scope_idx
  ON core.price_list (organization_id, scope) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS core.price_list_item (
  id uuid PRIMARY KEY,
  price_list_id uuid NOT NULL REFERENCES core.price_list (id),
  product_id uuid NOT NULL,
  uom text NOT NULL,
  unit_price numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (price_list_id, product_id, uom)
);
