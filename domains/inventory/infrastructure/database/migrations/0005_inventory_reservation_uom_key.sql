-- MVP-OD-12: one product in two units in one counter sale.
--
-- `stock_reservation` was unique per `(reference_type, reference_id, product_id)` with no unit, so a
-- sale could not hold 2 KARTON and 3 PCS of the same product: the second line collided with the
-- first and the insert failed, which POS then reported as a refused cart. A reservation is a
-- quantity of *one unit* of a product, so the unit belongs in the key — the same reasoning as
-- `stock_balance`, which has always been unique per `(warehouse_id, product_id)` and carries one `uom`.
--
-- This loosens the key, so it is safe to apply to a table that already has rows: every existing row
-- has a `uom`, and adding a column that is already present to a unique key cannot collide. Nothing is
-- rewritten and no row is removed. Forward-only, and the old constraint is named rather than dropped
-- blind — the name is Postgres's own default for that table's `UNIQUE (reference_type, reference_id,
-- product_id)`.
--
-- `issueInventory` matches its reservation on the same four columns, so the two agree on what a
-- "line" is: without the unit in both places, a two-unit handover would consume whichever line it
-- found first.

ALTER TABLE inventory.stock_reservation
  DROP CONSTRAINT IF EXISTS stock_reservation_reference_type_reference_id_product_id_key;

ALTER TABLE inventory.stock_reservation
  ADD CONSTRAINT stock_reservation_reference_product_uom_key
  UNIQUE (reference_type, reference_id, product_id, uom);
