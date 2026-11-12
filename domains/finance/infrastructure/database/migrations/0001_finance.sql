CREATE SCHEMA IF NOT EXISTS finance;

CREATE TABLE IF NOT EXISTS finance.account (
  code text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.accounting_period (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status text NOT NULL CHECK (status IN ('OPEN','SOFT_CLOSED','CLOSED')),
  soft_closed_at timestamptz,
  soft_closed_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  close_reason text,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text,
  reopen_approval_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS finance.posting_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  effective_from date NOT NULL,
  effective_to date,
  line_template jsonb NOT NULL CHECK (jsonb_typeof(line_template) = 'object'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (event_type, version)
);

CREATE TABLE IF NOT EXISTS finance.journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  number text NOT NULL,
  period_id uuid NOT NULL REFERENCES finance.accounting_period(id),
  business_date date NOT NULL,
  source_type text NOT NULL,
  source_event_id uuid UNIQUE,
  source_document_id text,
  source_document_number text,
  posting_rule_id uuid REFERENCES finance.posting_rule(id),
  status text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','POSTED','REVERSED')),
  maker_id uuid,
  approver_id uuid,
  approval_id uuid,
  reverses_journal_id uuid UNIQUE REFERENCES finance.journal(id),
  reversed_by_journal_id uuid UNIQUE REFERENCES finance.journal(id),
  reason text,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number),
  CHECK (maker_id IS NULL OR approver_id IS NULL OR maker_id <> approver_id)
);

CREATE TABLE IF NOT EXISTS finance.journal_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES finance.journal(id),
  line_number integer NOT NULL CHECK (line_number > 0),
  account_code text NOT NULL REFERENCES finance.account(code),
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journal_id, line_number),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX IF NOT EXISTS journal_period_idx ON finance.journal (organization_id, period_id, business_date);
CREATE INDEX IF NOT EXISTS journal_line_account_idx ON finance.journal_line (account_code, journal_id);

CREATE TABLE IF NOT EXISTS finance.posting_exception (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  business_date date NOT NULL,
  reason_code text NOT NULL,
  payload_reference jsonb NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RETRYING','RESOLVED')),
  owner text NOT NULL DEFAULT 'FINANCE',
  journal_id uuid REFERENCES finance.journal(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.event_inbox (
  event_id uuid PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.subledger_event (
  event_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  event_type text NOT NULL,
  business_date date NOT NULL,
  inventory_delta numeric(18,2) NOT NULL DEFAULT 0,
  receivable_delta numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION finance.protect_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED','REVERSED') THEN RAISE EXCEPTION 'POSTED_JOURNAL_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('POSTED','REVERSED') AND NOT (
    OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
    AND OLD.reversed_by_journal_id IS NULL AND NEW.reversed_by_journal_id IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'reversed_by_journal_id' - 'updated_at')
      = (to_jsonb(OLD) - 'status' - 'reversed_by_journal_id' - 'updated_at')
  ) THEN RAISE EXCEPTION 'POSTED_JOURNAL_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_posted_journal ON finance.journal;
CREATE TRIGGER protect_posted_journal BEFORE UPDATE OR DELETE ON finance.journal
FOR EACH ROW EXECUTE FUNCTION finance.protect_posted_journal();

CREATE OR REPLACE FUNCTION finance.protect_posted_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_status text;
BEGIN
  SELECT status INTO journal_status FROM finance.journal WHERE id = COALESCE(NEW.journal_id, OLD.journal_id);
  IF journal_status IN ('POSTED','REVERSED') THEN RAISE EXCEPTION 'POSTED_JOURNAL_IMMUTABLE'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_posted_journal_line ON finance.journal_line;
CREATE TRIGGER protect_posted_journal_line BEFORE INSERT OR UPDATE OR DELETE ON finance.journal_line
FOR EACH ROW EXECUTE FUNCTION finance.protect_posted_journal_line();

CREATE OR REPLACE FUNCTION finance.assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total_debit numeric(18,2); total_credit numeric(18,2); line_count integer; period_status text;
BEGIN
  IF NEW.status = 'POSTED' AND OLD.status IS DISTINCT FROM 'POSTED' THEN
    SELECT status INTO period_status FROM finance.accounting_period WHERE id = NEW.period_id FOR UPDATE;
    IF period_status = 'CLOSED' THEN RAISE EXCEPTION 'ACCOUNTING_PERIOD_CLOSED'; END IF;
    SELECT COALESCE(sum(debit),0), COALESCE(sum(credit),0), count(*)
      INTO total_debit, total_credit, line_count FROM finance.journal_line WHERE journal_id = NEW.id;
    IF line_count < 2 OR total_debit <> total_credit THEN RAISE EXCEPTION 'JOURNAL_NOT_BALANCED'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS assert_journal_balanced ON finance.journal;
CREATE TRIGGER assert_journal_balanced BEFORE UPDATE OF status ON finance.journal
FOR EACH ROW EXECUTE FUNCTION finance.assert_journal_balanced();
