-- INVOICE_ISSUED v1 (docs/mvp/MVP_PLAN.md §5) carries customerId, branchId and channel. The event is
-- built from the stored invoice, never from the caller's input, so the invoice has to hold them.
-- Nullable: invoices prepared before this migration have no value to backfill, and only the POS
-- channel publishes the v1 event.
ALTER TABLE sales.invoice ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE sales.invoice ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE sales.invoice ADD COLUMN IF NOT EXISTS channel text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_channel_check') THEN
    ALTER TABLE sales.invoice ADD CONSTRAINT invoice_channel_check CHECK (channel IS NULL OR channel IN ('POS'));
  END IF;
END $$;
