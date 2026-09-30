-- TAX-001 IN SCOPE ("default kode pajak per produk & per supplier/customer") and TAX-002
-- ("kode pajak per baris dari produk (override per customer bila EXEMPT)"): the customer master
-- carries the tax treatment that decides whether a sale to that customer is charged at the
-- product's code or overridden to zero.
--
-- This is a single current value, not an effective-dated range, and that is a deliberate reading of
-- DB.R06. DB.R06 names "policy, harga, tarif pajak, konfigurasi, mapping role akun, dan posting
-- rule" — a customer's tax treatment is none of those. The rate itself IS effective-dated
-- (`core.tax_rate`, DB.R06), so a regulatory change moves every customer's tax outcome from one
-- place; what is per-customer is a classification (PKP / bebas / bukan Command 7 and the rest), and
-- that is master data with the same version-and-audit lifecycle as the customer's name or segment.
-- Making it a range would add a second effective-dating mechanism for a fact whose history the
-- invoice snapshot already preserves (TAX-002.BR03). Recorded in `domains/tax/DOMAIN.md`.
--
-- Nullable with no default. A customer created before this migration has no recorded treatment, and
-- `null` means unresolved rather than zero-rated: `resolveSalesTax` fails closed on it
-- (TAX-002.E1) rather than assuming either exemption or liability. A DEFAULT would silently decide
-- that for every existing row, which is a business decision no migration may make.
--
-- Forward-only: a new nullable column with a CHECK. Nothing is rewritten and nothing is dropped, so
-- this applies with no downtime and rolls back by dropping the column alone.

ALTER TABLE core.customer
  ADD COLUMN IF NOT EXISTS tax_treatment text;

ALTER TABLE core.customer
  DROP CONSTRAINT IF EXISTS customer_tax_treatment_vocabulary;

ALTER TABLE core.customer
  ADD CONSTRAINT customer_tax_treatment_vocabulary
  CHECK (tax_treatment IS NULL OR tax_treatment IN ('VAT_OUTPUT', 'EXEMPT', 'NON_VAT'));

COMMENT ON COLUMN core.customer.tax_treatment IS
  'Sales tax code applied to this customer: VAT_OUTPUT, EXEMPT, or NON_VAT. NULL means undetermined and blocks a taxable invoice. VAT_INPUT is absent by design: input VAT belongs to the supplier purchase flow (TAX-003), not to a customer.';

-- TAX-001 IN SCOPE, second half: "default kode pajak per produk & per supplier/customer". The
-- product's own code is the default for a sales line; a customer's EXEMPT/NON_VAT treatment
-- overrides it (TAX-002). Without it, every line would have to be told its code by whichever
-- document happened to be built, and a product's tax classification would live in no record at all.
--
-- Nullable for the same reason as `customer.tax_treatment`: a product row that predates this
-- migration has no recorded code, and null is the honest state. TAX-002.E1 requires such a product
-- to block invoice issuance rather than be silently charged at some assumed rate, so `tax` refuses
-- it. Populated through `setProductTaxCode`; this domain still has no product ingestion path
-- (see DOMAIN.md open decisions), so the setter is the only writer today.
ALTER TABLE core.product
  ADD COLUMN IF NOT EXISTS tax_code text;

ALTER TABLE core.product
  DROP CONSTRAINT IF EXISTS product_tax_code_vocabulary;

ALTER TABLE core.product
  ADD CONSTRAINT product_tax_code_vocabulary
  CHECK (tax_code IS NULL OR tax_code IN ('VAT_OUTPUT', 'EXEMPT', 'NON_VAT'));

COMMENT ON COLUMN core.product.tax_code IS
  'Default sales tax code for lines of this product. NULL blocks issuance (TAX-002.E1). VAT_INPUT is absent: it is the supplier purchase flow''s code (TAX-003).';