-- MVP-OD-8: retain the owner's subject identity/version without writing owner tables.
ALTER TABLE platform.approval_request ADD COLUMN IF NOT EXISTS subject_type text;
ALTER TABLE platform.approval_request ADD COLUMN IF NOT EXISTS subject_version integer CHECK (subject_version > 0);
ALTER TABLE platform.approval_request ADD COLUMN IF NOT EXISTS context_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS approval_request_subject_version_idx
  ON platform.approval_request (organization_id, type_code, owner_domain, subject_ref, subject_version)
  WHERE subject_version IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform.approval_step (
  request_id uuid NOT NULL REFERENCES platform.approval_request(id),
  level integer NOT NULL CHECK (level BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  decided_by uuid,
  decided_at timestamptz,
  reason text,
  PRIMARY KEY (request_id, level)
);
CREATE TABLE IF NOT EXISTS platform.approval_inbox (
  event_id uuid PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform.approval_type (code, owner_domain, subject_type, expiry_hours, delegation_allowed, reason_required) VALUES
  ('journal', 'finance', 'Journal', 48, false, true),
  ('journal_reversal', 'finance', 'Journal', 48, false, true),
  ('period_reopen', 'finance', 'PeriodReopenRequest', 48, false, true),
  ('period_close', 'finance', 'PeriodCloseRequest', 48, false, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.approval_policy (id, type_code, effective_from, status) VALUES
  ('00000000-0000-4000-8000-00000000a101','journal','2026-01-01','ACTIVE'),
  ('00000000-0000-4000-8000-00000000a102','journal_reversal','2026-01-01','ACTIVE'),
  ('00000000-0000-4000-8000-00000000a103','period_reopen','2026-01-01','ACTIVE'),
  ('00000000-0000-4000-8000-00000000a104','period_close','2026-01-01','ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO platform.approval_level (policy_id, level, role_code, permission_code, max_amount) VALUES
  ('00000000-0000-4000-8000-00000000a101',1,'FINANCE_APPROVER','finance.journal.approve',NULL),
  ('00000000-0000-4000-8000-00000000a102',1,'FINANCE_APPROVER','finance.journal.approve',NULL),
  ('00000000-0000-4000-8000-00000000a103',1,'CFO','finance.period.reopen.approve',NULL),
  ('00000000-0000-4000-8000-00000000a104',1,'CFO','finance.close.approve',NULL)
ON CONFLICT DO NOTHING;
