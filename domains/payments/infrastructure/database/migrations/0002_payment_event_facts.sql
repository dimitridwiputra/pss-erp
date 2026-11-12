-- PAYMENT_RECEIVED and CASH_CUSTODY_VERIFIED v1 (docs/mvp/MVP_PLAN.md §5). Each event is built from
-- the stored fact, so the payment records where the cash is held and for whom, and the custody
-- record keeps its source, the verification business date, the reason for a variance, and a
-- version for the event's aggregateVersion. All additive and nullable except `version`, which
-- defaults to 1 for existing rows.
ALTER TABLE payments.payment ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE payments.payment ADD COLUMN IF NOT EXISTS invoice_id uuid;
ALTER TABLE payments.payment ADD COLUMN IF NOT EXISTS cash_location_type text;
ALTER TABLE payments.payment ADD COLUMN IF NOT EXISTS cash_location_id uuid;
ALTER TABLE payments.payment ADD COLUMN IF NOT EXISTS business_date date;

ALTER TABLE payments.cash_custody_record ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE payments.cash_custody_record ADD COLUMN IF NOT EXISTS reason_code text;
ALTER TABLE payments.cash_custody_record ADD COLUMN IF NOT EXISTS verified_business_date date;
ALTER TABLE payments.cash_custody_record ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_cash_location_type_check') THEN
    ALTER TABLE payments.payment ADD CONSTRAINT payment_cash_location_type_check
      CHECK (cash_location_type IS NULL OR cash_location_type IN ('POS_SHIFT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_custody_record_version_check') THEN
    ALTER TABLE payments.cash_custody_record ADD CONSTRAINT cash_custody_record_version_check CHECK (version > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cash_custody_record_source_idx ON payments.cash_custody_record (source, source_id);
