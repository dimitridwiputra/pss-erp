-- PLT-005: the tax domain's own inbox receipt table.
--
-- `withInbox` is a shared transaction boundary, but each consumer owns its receipt table, so this
-- is tax's. It is the exactly-once guard for `applyApprovalDecision`: DEC-109 keeps the approval
-- decision in `platform.approval` and requires the owning domain to run the effect, so tax
-- re-applies nothing on a redelivered APPROVAL_DECIDED (PLT-005.BR03, APR-001.AC04).
--
-- Columns mirror `reporting.inbox_event` (see domains/reporting) so a reader who has seen one
-- consumer's receipt table recognises the other.
CREATE TABLE IF NOT EXISTS core.tax_inbox_event (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);