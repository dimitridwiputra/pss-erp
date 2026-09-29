-- Adds RECEIVE (WMS-003 goods receipt, no PO/costing yet) and keeps ADJUSTMENT (WMS-010/011
-- discrepancy correction) as valid stock_movement types alongside the existing ISSUE.
ALTER TABLE inventory.stock_movement DROP CONSTRAINT stock_movement_movement_type_check;
ALTER TABLE inventory.stock_movement ADD CONSTRAINT stock_movement_movement_type_check
  CHECK (movement_type IN ('RECEIVE', 'ISSUE', 'ADJUSTMENT'));
