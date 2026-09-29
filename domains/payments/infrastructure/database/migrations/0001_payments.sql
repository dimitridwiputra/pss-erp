CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE IF NOT EXISTS payments.payment (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('POS', 'CASHIER', 'BANK', 'FIELD')),
  method text NOT NULL CHECK (method IN ('TUNAI', 'QRIS', 'TRANSFER', 'GIRO', 'CEK')),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'BOUNCED', 'REVERSED')),
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  accepted_by uuid NOT NULL,
  verified_by uuid,
  verified_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_reference_idx ON payments.payment (reference_type, reference_id);

CREATE TABLE IF NOT EXISTS payments.cash_custody_record (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('POS_SHIFT', 'SFA', 'FLEET')),
  collector_id uuid NOT NULL,
  declared_amount numeric(18,2) NOT NULL CHECK (declared_amount >= 0),
  counted_amount numeric(18,2),
  status text NOT NULL CHECK (status IN ('DECLARED', 'VERIFIED', 'DISCREPANCY', 'RESOLVED')),
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments.cash_custody_payment (
  cash_custody_record_id uuid NOT NULL REFERENCES payments.cash_custody_record (id),
  payment_id uuid NOT NULL REFERENCES payments.payment (id),
  PRIMARY KEY (cash_custody_record_id, payment_id)
);
