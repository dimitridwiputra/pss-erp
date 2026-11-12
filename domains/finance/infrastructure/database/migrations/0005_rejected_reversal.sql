-- Keep rejected reversal requests for audit while allowing a later corrected request.
ALTER TABLE finance.journal DROP CONSTRAINT journal_status_check;
ALTER TABLE finance.journal ADD CONSTRAINT journal_status_check
  CHECK (status IN ('DRAFT','PENDING_APPROVAL','POSTED','REVERSED','REJECTED'));
ALTER TABLE finance.journal DROP CONSTRAINT journal_reverses_journal_id_key;
CREATE UNIQUE INDEX journal_one_active_reversal_idx
  ON finance.journal (reverses_journal_id)
  WHERE reverses_journal_id IS NOT NULL
    AND status IN ('PENDING_APPROVAL','POSTED','REVERSED');
