-- Reason vocabulary for stock adjustments (INV-004/005/006 all adjust stock for a stated cause).
--
-- This is a reference table rather than a database enum because the codes are a business
-- classification, and AGENTS.md §11.1 reserves enums for vocabulary that is stable and reserves
-- reference tables for exactly this case: an operator has to be able to read the allowed list to
-- render a reason picker, and a new cause has to be addable without a schema change on a table that
-- already holds movements.
--
-- SCOPE: platform-level, not per organization. MVP_PLAN item 5 names four demo codes, and the MVP
-- runs a single organization, so a row is a code and its Indonesian label with no organization
-- column. Whether a principal may add its own reason codes is MVP-OD-14 in MVP_PLAN §10 — the
-- decision is not made here, and this table's shape is the thing that decision would change.
--
-- `is_active` retires a code without deleting it: movements already written against a retired code
-- must keep resolving to a label, and the retirement only stops new adjustments from choosing it.
--
-- Every statement is replayable (apply-migrations.mjs applies the ordered list to a fresh database),
-- so the seed is an ON CONFLICT DO NOTHING rather than a plain INSERT.

CREATE TABLE IF NOT EXISTS inventory.stock_adjustment_reason (
  code text PRIMARY KEY,
  label text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO inventory.stock_adjustment_reason (code, label) VALUES
  ('RUSAK', 'Barang rusak'),
  ('HILANG', 'Barang hilang'),
  ('SELISIH_HITUNG', 'Selisih hasil hitung fisik'),
  ('KOREKSI', 'Koreksi pencatatan')
ON CONFLICT (code) DO NOTHING;
