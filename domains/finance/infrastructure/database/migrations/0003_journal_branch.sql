-- MVP-OD-10: branch is an explicit journal dimension, never reconstructed in the browser.
ALTER TABLE finance.journal ADD COLUMN IF NOT EXISTS branch_id uuid;
CREATE INDEX IF NOT EXISTS journal_branch_report_idx
  ON finance.journal (organization_id, branch_id, business_date)
  WHERE status IN ('POSTED','REVERSED');
