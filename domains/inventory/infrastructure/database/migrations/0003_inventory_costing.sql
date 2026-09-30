-- Moving-average costing columns (INV-003, MVP-OD-4). Forward-only, additive, no data rewritten.
--
-- BACKFILL NOTE: none, by decision. Rows written before this migration keep NULL in every new
-- column, and NULL means UNVALUED — the product in that warehouse has never had a cost recorded.
-- That is a real state, not missing data to be guessed at: a NULL `avg_unit_cost` tells
-- `listStockBalances` to report no value and tells `listLowStockBalances` nothing about cost, and a
-- NULL `unit_cost`/`total_cost` on a movement makes the event unvalued, which finance routes to its
-- exception queue rather than posting zero (MVP_PLAN §5). Back-filling a cost from any other source
-- would invent a valuation nobody agreed to, so the pre-costing rows stay unvalued until a real
-- receipt or a manual, audited revaluation records one.
--
-- GRANULARITY: `stock_balance` is unique per `(warehouse_id, product_id)` and carries one `uom`, so
-- the average it holds is per warehouse × product × UoM (MVP-OD-4). The PRD's `inventory.valuation_unit`
-- would place that average at BRANCH level instead; that is MVP-OD-12 in MVP_PLAN §10 and is not
-- decided here, so this migration changes no key that the granularity decision would move.
--
-- PRECISION: 4 fraction digits for a unit cost, 2 for a total, matching the column scales. The PRD
-- (INV-003.BR01) names `inventory.cost_precision` with a default of 6 for unit cost. That conflict is
-- MVP-OD-13 in MVP_PLAN §10; 4 is used here because it is the scale the column and the event payload
-- carry, and raising it later is a widening migration that cannot lose a value already stored.

ALTER TABLE inventory.stock_balance
  ADD COLUMN IF NOT EXISTS avg_unit_cost numeric(18,4) NULL;

ALTER TABLE inventory.stock_movement
  ADD COLUMN IF NOT EXISTS unit_cost numeric(18,4) NULL,
  ADD COLUMN IF NOT EXISTS total_cost numeric(18,2) NULL;

-- A cost is never negative: a negative unit cost would let an issue raise the inventory value.
-- `qty_delta` on a movement is signed, `unit_cost` is not.
ALTER TABLE inventory.stock_balance DROP CONSTRAINT IF EXISTS stock_balance_avg_unit_cost_non_negative;
ALTER TABLE inventory.stock_balance ADD CONSTRAINT stock_balance_avg_unit_cost_non_negative
  CHECK (avg_unit_cost IS NULL OR avg_unit_cost >= 0);

ALTER TABLE inventory.stock_movement DROP CONSTRAINT IF EXISTS stock_movement_unit_cost_non_negative;
ALTER TABLE inventory.stock_movement ADD CONSTRAINT stock_movement_unit_cost_non_negative
  CHECK (unit_cost IS NULL OR unit_cost >= 0);

-- The movement history screen reads one warehouse's ledger newest-first, and the low-stock tile
-- reads balances that are short. Both are the two list queries this domain adds, so they are the
-- only access paths the index has to serve.
CREATE INDEX IF NOT EXISTS stock_movement_warehouse_ledger_idx
  ON inventory.stock_movement (warehouse_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS stock_balance_warehouse_product_idx
  ON inventory.stock_balance (warehouse_id, product_id);
