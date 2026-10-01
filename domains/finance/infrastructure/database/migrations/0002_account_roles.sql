-- MVP-OD-7: account roles, rather than account names or number prefixes, own control policy.
CREATE TABLE IF NOT EXISTS finance.account_role (
  code text PRIMARY KEY,
  is_control_account boolean NOT NULL DEFAULT false,
  subledger_owner text,
  manual_posting_policy text NOT NULL CHECK (manual_posting_policy IN ('DENY','TEMPLATE_ONLY','ALLOW')),
  reconciliation_pair text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_control_account OR (subledger_owner IS NOT NULL AND manual_posting_policy = 'DENY'))
);

CREATE TABLE IF NOT EXISTS finance.account_role_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code text NOT NULL REFERENCES finance.account_role(code),
  account_code text NOT NULL REFERENCES finance.account(code),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (role_code, account_code, effective_from)
);
CREATE INDEX IF NOT EXISTS account_role_mapping_account_idx
  ON finance.account_role_mapping(account_code, effective_from, effective_to);

INSERT INTO finance.account_role (code, is_control_account, subledger_owner, manual_posting_policy, reconciliation_pair) VALUES
  ('AR_CONTROL', true, 'ar', 'DENY', 'receivables'),
  ('AP_CONTROL', true, 'ap', 'DENY', 'payables'),
  ('GRNI', true, 'inventory', 'DENY', 'goods_received_not_invoiced'),
  ('INVENTORY', true, 'inventory', 'DENY', 'inventory_value'),
  ('INVENTORY_IN_TRANSIT', true, 'inventory', 'DENY', 'inventory_in_transit'),
  ('INVENTORY_IN_TRANSFER', true, 'inventory', 'DENY', 'inventory_in_transfer'),
  ('INVENTORY_QUARANTINE', true, 'inventory', 'DENY', 'inventory_quarantine_valued'),
  ('UNAPPLIED_RECEIPTS', true, 'payments', 'DENY', 'unapplied_receipts'),
  ('CUSTOMER_DEPOSITS', true, 'payments', 'DENY', 'customer_deposits'),
  ('CASH_IN_TRANSIT', true, 'payments', 'DENY', 'cash_in_transit'),
  ('BANK', false, NULL, 'ALLOW', NULL),
  ('CASH_ON_HAND', false, NULL, 'ALLOW', NULL),
  ('PETTY_CASH', false, NULL, 'ALLOW', NULL)
  ,('SALES_REVENUE', false, NULL, 'ALLOW', NULL)
  ,('COGS', false, NULL, 'ALLOW', NULL)
ON CONFLICT (code) DO NOTHING;

-- A database guard protects every path, including a future command that bypasses the API validator.
CREATE OR REPLACE FUNCTION finance.reject_manual_control_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_source text; journal_date date;
BEGIN
  SELECT source_type, business_date INTO journal_source, journal_date
    FROM finance.journal WHERE id = NEW.journal_id;
  IF journal_source IN ('MANUAL','ADJUSTMENT') AND EXISTS (
    SELECT 1 FROM finance.account_role_mapping mapping
    JOIN finance.account_role role ON role.code = mapping.role_code
    WHERE mapping.account_code = NEW.account_code
      AND role.manual_posting_policy = 'DENY'
      AND mapping.effective_from <= journal_date
      AND (mapping.effective_to IS NULL OR mapping.effective_to > journal_date)
  ) THEN RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POSTING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reject_manual_control_line BEFORE INSERT OR UPDATE ON finance.journal_line
FOR EACH ROW EXECUTE FUNCTION finance.reject_manual_control_line();

CREATE OR REPLACE FUNCTION finance.assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total_debit numeric(18,2); total_credit numeric(18,2); line_count integer; period_status text;
BEGIN
  IF NEW.status = 'POSTED' AND OLD.status IS DISTINCT FROM 'POSTED' THEN
    SELECT status INTO period_status FROM finance.accounting_period WHERE id = NEW.period_id FOR UPDATE;
    IF period_status = 'CLOSED' THEN RAISE EXCEPTION 'ACCOUNTING_PERIOD_CLOSED'; END IF;
    SELECT COALESCE(sum(debit),0), COALESCE(sum(credit),0), count(*)
      INTO total_debit, total_credit, line_count FROM finance.journal_line WHERE journal_id = NEW.id;
    IF line_count < 2 OR total_debit <> total_credit THEN RAISE EXCEPTION 'JOURNAL_NOT_BALANCED'; END IF;
    IF NEW.source_type IN ('MANUAL','ADJUSTMENT') AND EXISTS (
      SELECT 1 FROM finance.journal_line line
      JOIN finance.account_role_mapping mapping ON mapping.account_code = line.account_code
      JOIN finance.account_role role ON role.code = mapping.role_code
      WHERE line.journal_id = NEW.id AND role.manual_posting_policy = 'DENY'
        AND mapping.effective_from <= NEW.business_date
        AND (mapping.effective_to IS NULL OR mapping.effective_to > NEW.business_date)
    ) THEN RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POSTING'; END IF;
  END IF;
  RETURN NEW;
END $$;
