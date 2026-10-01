-- TAX-001: the statutory tax code vocabulary as reference rows.
--
-- `core.tax_code` is global and its CHECK already fixes the four codes, but the table shipped empty,
-- so every environment had to insert the codes by hand before any sale could resolve even a zero
-- tax: `resolveSalesTax` refuses a code it cannot find. These are vocabulary, not configuration —
-- no rate, no organization, nothing a business decision sets (rates stay in `core.tax_rate`, behind
-- approval). Whether two codes are zero-rated is part of what they mean.
--
-- ON CONFLICT DO NOTHING, so a database that already inserted a code keeps its row and its id.
INSERT INTO core.tax_code (id, code, name, zero_rated) VALUES
  ('6f1d0a3e-7c2b-4e51-9a0b-2b7d5d1e0001', 'VAT_OUTPUT', 'PPN Keluaran', false),
  ('6f1d0a3e-7c2b-4e51-9a0b-2b7d5d1e0002', 'VAT_INPUT', 'PPN Masukan', false),
  ('6f1d0a3e-7c2b-4e51-9a0b-2b7d5d1e0003', 'EXEMPT', 'Bebas PPN', true),
  ('6f1d0a3e-7c2b-4e51-9a0b-2b7d5d1e0004', 'NON_VAT', 'Tidak Kena PPN', true)
ON CONFLICT (code) DO NOTHING;
