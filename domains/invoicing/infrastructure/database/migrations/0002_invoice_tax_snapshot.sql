-- TAX-002.BR03 / NC01: an ISSUED invoice's tax is a snapshot and is never recalculated.
--
-- `sales.invoice_line` previously stored only `tax_amount`, which answers "how much tax" but not
-- "under which code, at which rate, over which base, with which rounding rule". Without those, a
-- configuration change leaves a historical invoice unexplainable — and a credit note over it has
-- nothing to reuse, which TAX-002.AC02 requires ("nota kredit atas invoice bulan lalu setelah tarif
-- berubah, Then tarif invoice asal dipakai").
--
-- The four columns are therefore the snapshot:
--   tax_code            the applied code, so the treatment that produced the amount is on the document
--   tax_rate            the rate in percentage points, so the arithmetic can be re-checked
--   tax_base            the DPP (dasar pengenaan pajak), so the rate can be applied to a different quantity
--   tax_rounding_rule   the rounding mode, so the half-sen decisions are reproducible
--
-- All four are NULLABLE and default to NULL. They are NULL on rows written before this migration,
-- and NULL is also what marks a row whose tax could not be resolved — the invoice would then be
-- blocked rather than issued (TAX-001.AC02), so no ISSUED invoice carries a NULL snapshot. A
-- NOT NULL column would have required a default value, and a default tax code on a historical line
-- is exactly the invented rate this feature exists to remove.
--
-- `CHECK (tax_rate IS NULL OR tax_rate >= 0)` keeps a negative rate out; the vocabulary of
-- `tax_code` is deliberately NOT re-declared here, because it belongs to `core.tax_code` and a
-- second CHECK would be a second place to update it (AGENTS.md §18, DB.R01: `sales` may not
-- reference `core`). The application contract validates it.
--
-- Forward-only: additive columns and a CHECK constraint. No existing value is rewritten and nothing
-- is dropped, so it applies with no downtime and rolls back by dropping these columns.

ALTER TABLE sales.invoice_line
  ADD COLUMN IF NOT EXISTS tax_code text;

ALTER TABLE sales.invoice_line
  ADD COLUMN IF NOT EXISTS tax_rate numeric(9,6);

ALTER TABLE sales.invoice_line
  ADD COLUMN IF NOT EXISTS tax_base numeric(18,2);

ALTER TABLE sales.invoice_line
  ADD COLUMN IF NOT EXISTS tax_rounding_rule text;

ALTER TABLE sales.invoice_line
  DROP CONSTRAINT IF EXISTS invoice_line_tax_rate_non_negative;

ALTER TABLE sales.invoice_line
  ADD CONSTRAINT invoice_line_tax_rate_non_negative
  CHECK (tax_rate IS NULL OR tax_rate >= 0);

COMMENT ON COLUMN sales.invoice_line.tax_code IS
  'TAX-002.BR03 snapshot: the tax code applied to this line. NULL on rows written before tax resolution existed.';
COMMENT ON COLUMN sales.invoice_line.tax_rate IS
  'TAX-002.BR03 snapshot: the rate applied, in percentage points (11.000000 = 11%).';
COMMENT ON COLUMN sales.invoice_line.tax_base IS
  'TAX-002.BR03 snapshot: the line''s net amount after discount, the DPP the rate was applied to.';
COMMENT ON COLUMN sales.invoice_line.tax_rounding_rule IS
  'TAX-002.BR03 snapshot: the rounding mode that produced tax_amount (tax.rounding_rule).';

-- `sales.invoice.tax_total` already exists and is what the document carries. This adds the scope of
-- the rounding that produced it, so a reader of the header can tell a per-line sum from a
-- document-level rounding without reading every line.
ALTER TABLE sales.invoice
  ADD COLUMN IF NOT EXISTS tax_rounding_rule text;

COMMENT ON COLUMN sales.invoice.tax_rounding_rule IS
  'The rounding rule whose scope produced tax_total. NULL on invoices written before tax resolution existed.';