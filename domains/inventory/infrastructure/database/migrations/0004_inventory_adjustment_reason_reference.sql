-- Reason vocabulary for stock adjustments (INV-004/005/006 all adjust stock for a stated cause).
--
-- This is a reference table rather than a database enum because the codes are a business
-- classification, and AGENTS.md §11.1 reserves enums for vocabulary that is stable and reserves
-- reference tables for exactly this case: an operator has to be able to read the allowed list to
-- render a reason picker, and a new cause has to be addable without a schema change on a table that
-- already holds movements.
--
-- THE CODES ARE NOT INVENTED HERE. They are the registered reason codes from the PRD's Appendix F.3,
-- transcribed: the INV area (`RC-INV-*`, which is what a stock adjustment is) and the WMS
-- discrepancy codes (`RC-WMS-DISC_*`, `RC-WMS-SHORT_*`) that `domains/wms` already writes through
-- `adjustStock` and that the existing integration test exercises. F.3 also requires every list to
-- carry an `…_OTHER` with a mandatory note; `RC-INV-OTHER` is that code, and the note field the PRD
-- asks for is MVP-OD-18.
--
-- `label` is the Indonesian text the UI shows. F.3 says a code is never shown raw to a user, so this
-- column — not the code — is what a reason picker renders, and it is why a code registered only as
-- `RC-INV-DAMAGED` still reaches an operator as "Barang rusak".
--
-- SCOPE: platform-level, not per organization. The MVP runs a single organization and Appendix F.3
-- registers one vocabulary, so a row is a code plus its label with no `organization_id`. Whether a
-- principal may add its own codes is MVP-OD-14 in MVP_PLAN §10 — that decision, not this migration,
-- would change this table's shape.
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
  -- INV: a stock adjustment's own vocabulary (PRD Appendix F.3, area INV).
  ('RC-INV-COUNT_VARIANCE', 'Selisih hasil hitung fisik'),
  ('RC-INV-DAMAGED', 'Barang rusak'),
  ('RC-INV-EXPIRED', 'Barang kedaluwarsa'),
  ('RC-INV-FOUND', 'Barang ditemukan (kelebihan)'),
  ('RC-INV-LOST', 'Barang hilang'),
  ('RC-INV-OTHER', 'Lainnya — wajib isi keterangan'),
  ('RC-INV-TRANSIT_LOSS', 'Hilang dalam pengiriman'),
  -- WMS: the codes `domains/wms` already passes to `adjustStock` for a discrepancy or a shortage.
  ('RC-WMS-DISC_DAMAGED', 'Barang rusak di lokasi'),
  ('RC-WMS-DISC_EXCESS', 'Kelebihan hitung fisik'),
  ('RC-WMS-DISC_MISSING', 'Kekurangan hitung fisik'),
  ('RC-WMS-DISC_WRONG_LOCATION', 'Salah lokasi'),
  ('RC-WMS-SHORT_DAMAGED', 'Kurang karena barang rusak'),
  ('RC-WMS-SHORT_EXPIRED', 'Kurang karena barang kedaluwarsa'),
  ('RC-WMS-SHORT_NOT_FOUND', 'Kurang karena barang tidak ditemukan')
ON CONFLICT (code) DO NOTHING;

-- The reason on the ledger row itself, not only on the event and the audit entry. The event is
-- delivered at least once and the audit trail is written by whoever asked; the movement row is the
-- reconciliation record, and "every movement for reason RC-INV-DAMAGED in this warehouse" is a
-- question the Stok screen has to answer from the ledger. Nullable because a receipt and a handover
-- have no reason, and it references the table above so a code here is always a code an operator could
-- have chosen.
ALTER TABLE inventory.stock_movement
  ADD COLUMN IF NOT EXISTS reason_code text REFERENCES inventory.stock_adjustment_reason (code);

-- `listStockMovements` filters and sorts on this, and the screen shows newest first per warehouse.
CREATE INDEX IF NOT EXISTS stock_movement_reason_idx
  ON inventory.stock_movement (warehouse_id, reason_code, created_at DESC)
  WHERE reason_code IS NOT NULL;
