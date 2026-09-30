-- Setoran Kas lists handovers by branch (the verifier's CASHIER role is BRANCH-scoped). The branch
-- is stored with the record so the list can be scoped and paginated in SQL, rather than filtered
-- row by row after a page was already cut. Nullable: records declared before this have none.
ALTER TABLE payments.cash_custody_record ADD COLUMN IF NOT EXISTS branch_id uuid;
CREATE INDEX IF NOT EXISTS cash_custody_record_branch_status_idx
  ON payments.cash_custody_record (organization_id, branch_id, status, created_at DESC);

-- The same for a payment, so "cash not yet deposited" can be summed per branch.
ALTER TABLE payments.payment ADD COLUMN IF NOT EXISTS branch_id uuid;
CREATE INDEX IF NOT EXISTS payment_pending_cash_idx
  ON payments.payment (organization_id, branch_id) WHERE channel = 'POS' AND method = 'TUNAI' AND status = 'PENDING_VERIFICATION';
