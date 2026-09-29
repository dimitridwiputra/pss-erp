import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const GetStockBalancesInputSchema = z.strictObject({ warehouseId: z.uuid() });
export type GetStockBalancesInput = z.input<typeof GetStockBalancesInputSchema>;

export interface StockBalanceRow {
  productId: string;
  uom: string;
  qtyOnHand: string;
  qtyReserved: string;
}

/**
 * Read-only: every product's on-hand/reserved balance for one warehouse. No audit entry (a query,
 * not a mutation). Added for `domains/wms`'s WMS-002 activation reconciliation, which must compare
 * Σ physical stock against the financial balance without reaching into `inventory`'s own tables
 * (AGENTS.md's "no cross-domain DB access" rule) — this was flagged as future work in this
 * domain's own DOMAIN.md open decisions ("no query surface exists yet to read a balance without
 * mutating it") until a real caller needed one.
 */
export async function getStockBalances(pool: Pool, client: PoolClient | undefined, input: GetStockBalancesInput): Promise<StockBalanceRow[]> {
  const parsed = GetStockBalancesInputSchema.parse(input);
  const runner = client ?? pool;
  const result = await runner.query<{ product_id: string; uom: string; qty_on_hand: string; qty_reserved: string }>(
    `SELECT product_id, uom, qty_on_hand, qty_reserved FROM inventory.stock_balance WHERE warehouse_id = $1`,
    [parsed.warehouseId],
  );
  return result.rows.map((row) => ({ productId: row.product_id, uom: row.uom, qtyOnHand: row.qty_on_hand, qtyReserved: row.qty_reserved }));
}
