import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '@pss/contracts';

/**
 * The costing inputs `applyMovingAverage` needs, read as strings because a `numeric` never touches a
 * JS number on the way in or out.
 */
export interface BalanceState {
  warehouseId: string;
  productId: string;
  qtyOnHand: string;
  qtyReserved: string;
  /** `null` when the balance has never been valued (MVP-OD-15). */
  avgUnitCost: string | null;
}

/** How a movement may interact with what is already reserved. */
export type BalanceWriteGuard =
  /** Every path: a receipt and a handover leave the reserved quantity alone or reduce it in step. */
  | 'ALWAYS'
  /**
   * An adjustment (WMS-010/011): the correction may not push on-hand below what is already reserved,
   * because those units are committed to a sale that has not been picked up yet. The database CHECK
   * `qty_reserved <= qty_on_hand` would catch it too, but as a constraint violation with no field to
   * point at — so the condition is in the `WHERE` and a rejected row becomes a `VALIDATION_FAILED`
   * that names the line.
   */
  | 'MUST_NOT_DROP_BELOW_RESERVED';

/**
 * Reads one `(warehouse, product)` balance under `FOR UPDATE`, creating the zero row when the product
 * has never been stocked there.
 *
 * The row lock is what makes costing safe. Two receipts for the same product would otherwise both read
 * the same average, both average into it, and both write back — and the result would be an average of
 * neither. Every movement path takes this lock before it computes anything, so they serialise, and
 * `writeBalanceQuantity` runs on the row that is still locked.
 *
 * The insert-then-select is two statements rather than one upsert because the caller needs the row's
 * `avg_unit_cost` as it was *before* this movement, and an upsert's `RETURNING` clause would report a
 * value this statement itself chose. It is also safe against a concurrent insert from another
 * transaction: the loser of the insert race waits for the winner's row and then reads it.
 */
export async function lockBalance(
  tx: PoolClient,
  organizationId: string,
  warehouseId: string,
  productId: string,
  uom: string,
): Promise<BalanceState> {
  await tx.query(
    `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
     VALUES ($1, $2, $3, $4, $5, 0, 0, 1)
     ON CONFLICT (warehouse_id, product_id) DO NOTHING`,
    [randomUUID(), organizationId, warehouseId, productId, uom],
  );
  const locked = await tx.query<{ qty_on_hand: string; qty_reserved: string; avg_unit_cost: string | null }>(
    `SELECT qty_on_hand, qty_reserved, avg_unit_cost FROM inventory.stock_balance
     WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE`,
    [warehouseId, productId],
  );
  const row = locked.rows[0];
  if (!row) throw new Error('Stock balance row disappeared while it was locked.');
  return {
    warehouseId, productId,
    qtyOnHand: row.qty_on_hand, qtyReserved: row.qty_reserved, avgUnitCost: row.avg_unit_cost,
  };
}

export interface BalanceWrite {
  qtyOnHandDelta: string;
  /**
   * Zero for everything except a handover. A handover consumes a reservation, so the reserved
   * quantity comes back with the on-hand quantity; leaving it behind would let the same units be
   * promised to a second sale.
   */
  qtyReservedDelta: string;
  avgUnitCost: string | null;
}

/**
 * Applies the movement to the locked balance in one statement.
 *
 * The deltas are applied in SQL rather than by writing back an absolute quantity, so the stored
 * quantity stays decimal-exact however many movements a day add up to, and the `qty_reserved <=
 * qty_on_hand` CHECK is evaluated against the values this statement produces.
 */
export async function writeBalanceQuantity(
  tx: PoolClient,
  balance: Pick<BalanceState, 'warehouseId' | 'productId'>,
  write: BalanceWrite,
  guard: BalanceWriteGuard = 'ALWAYS',
): Promise<void> {
  const condition = guard === 'MUST_NOT_DROP_BELOW_RESERVED'
    ? 'qty_on_hand + $1::numeric >= qty_reserved + $2::numeric'
    : 'TRUE';
  const result = await tx.query(
    `UPDATE inventory.stock_balance
     SET qty_on_hand = qty_on_hand + $1::numeric,
         qty_reserved = qty_reserved + $2::numeric,
         avg_unit_cost = $3::numeric,
         version = version + 1,
         updated_at = now()
     WHERE warehouse_id = $4 AND product_id = $5 AND ${condition}`,
    [write.qtyOnHandDelta, write.qtyReservedDelta, write.avgUnitCost, balance.warehouseId, balance.productId],
  );
  if (result.rowCount === 0) {
    throw new DomainError('VALIDATION_FAILED', [], [{
      path: 'lines', code: 'below_reserved', message: 'Penyesuaian membuat stok di bawah yang sudah dicadangkan.',
    }]);
  }
}
