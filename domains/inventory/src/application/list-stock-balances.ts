import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '@pss/contracts';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const ListStockBalancesInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  /** Matches the product id. The product's name and SKU are `master-data`'s facts, not this ones. */
  query: z.string().trim().max(100).optional(),
  /** One product exactly — the Stok screen's per-product view, where an `ILIKE` would be ambiguous. */
  productId: z.uuid().optional(),
  /**
   * Restrict to these products, ANDed with every other filter.
   *
   * This is how a **search by name** reaches the ledger. `core.product` is `master-data`'s table, so
   * this domain cannot match a name or a SKU (AGENTS.md §3.1); the API layer asks `master-data` for
   * the ids that match and passes them here. An **empty array matches nothing**, which is the point:
   * a search that finds no product must return an empty page, never the unfiltered warehouse.
   */
  productIds: z.array(z.uuid()).optional(),
  /** Only balances at or below this quantity — the dashboard's "stok menipis" tile. */
  maxQty: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  /** Only balances that have never been valued, which the exception queue needs to see. */
  unvaluedOnly: z.boolean().optional(),
  page: z.number().int().positive().max(10_000).optional(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  sort: z.enum(['product', 'qtyOnHand', 'value']).optional(),
});

export type ListStockBalancesInput = z.input<typeof ListStockBalancesInputSchema>;

export interface StockBalanceListItem {
  productId: string;
  uom: string;
  qtyOnHand: string;
  qtyReserved: string;
  /** `null` when the balance has never been valued (MVP-OD-16). */
  avgUnitCost: string | null;
  /**
   * `qtyOnHand × avgUnitCost`, in the database, and `null` when the balance is unvalued.
   *
   * Computed in SQL rather than here so the value shown is the value the ledger holds, to the cent,
   * with no decimal re-multiplication in JavaScript. The stored `avg_unit_cost` is 4 places and the
   * value is reported at 2, so the two can differ from `qty × the 2-place cost` by a fraction of a
   * rupiah — the value is the authoritative one.
   */
  stockValue: string | null;
}

export interface StockBalancePage {
  items: StockBalanceListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /** Σ stock value across the whole filtered set, not just this page. `null` if any balance is unvalued. */
  totalValue: string | null;
  /** How many balances in that set carry no value yet, so a blank total can say why. */
  unvaluedCount: number;
}

const SORT_COLUMNS = { product: 'product_id', qtyOnHand: 'qty_on_hand', value: 'stock_value' } as const;

/**
 * Balances for one warehouse, with their value, for the Stok screen and the dashboard.
 *
 * `totalValue` is a running figure over the filtered set so the screen can show "total persediaan"
 * next to a page of 20 rows; it is `null` when any balance in the set is unvalued, because a total
 * that quietly omitted unvalued stock would understate inventory value and look like an answer.
 */
export async function listStockBalances(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ListStockBalancesInput,
): Promise<StockBalancePage> {
  const input = parseCommandInput(ListStockBalancesInputSchema, rawInput);
  const runner = client ?? pool;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortColumn = SORT_COLUMNS[input.sort ?? 'product'];

  const conditions = ['organization_id = $1', 'warehouse_id = $2'];
  const values: unknown[] = [input.organizationId, input.warehouseId];
  if (input.productId) {
    values.push(input.productId);
    conditions.push(`product_id = $${values.length}`);
  }
  if (input.productIds) {
    if (input.productIds.length === 0) {
      // An id set that resolved to nothing. Short-circuited rather than skipped, because skipping
      // the filter would answer with the whole warehouse for a search that matched nothing.
      return { items: [], page, pageSize, total: 0, hasMore: false, totalValue: '0.00', unvaluedCount: 0 };
    }
    values.push(input.productIds);
    conditions.push(`product_id = ANY($${values.length}::uuid[])`);
  }
  if (input.query) {
    values.push(`%${input.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    conditions.push(`product_id::text ILIKE $${values.length} ESCAPE '\\'`);
  }
  if (input.maxQty) {
    values.push(input.maxQty);
    conditions.push(`qty_on_hand <= $${values.length}::numeric`);
  }
  if (input.unvaluedOnly) conditions.push('avg_unit_cost IS NULL');
  const where = conditions.join(' AND ');
  const value = `CASE WHEN avg_unit_cost IS NULL THEN NULL ELSE round(qty_on_hand * avg_unit_cost, 2) END`;

  const summary = await runner.query<{ total: string; total_value: string | null; unvalued: number }>(
    `SELECT count(*) AS total,
            CASE WHEN count(*) FILTER (WHERE avg_unit_cost IS NULL) > 0 THEN NULL
                 ELSE sum(round(qty_on_hand * avg_unit_cost, 2))::text END AS total_value,
            count(*) FILTER (WHERE avg_unit_cost IS NULL) AS unvalued
     FROM inventory.stock_balance WHERE ${where}`,
    values,
  );
  const total = Number(summary.rows[0]?.total ?? 0);
  const totalValue = summary.rows[0]?.total_value ?? null;
  const offset = (page - 1) * pageSize;

  const rows = await runner.query<{
    product_id: string; uom: string; qty_on_hand: string; qty_reserved: string;
    avg_unit_cost: string | null; stock_value: string | null;
  }>(
    `SELECT product_id, uom, qty_on_hand, qty_reserved, avg_unit_cost, ${value} AS stock_value
     FROM inventory.stock_balance
     WHERE ${where}
     ORDER BY ${sortColumn} ${input.sort === 'product' ? 'ASC' : 'DESC'}, product_id ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset],
  );

  return {
    items: rows.rows.map((row) => ({
      productId: row.product_id,
      uom: row.uom,
      qtyOnHand: row.qty_on_hand,
      qtyReserved: row.qty_reserved,
      avgUnitCost: row.avg_unit_cost,
      stockValue: row.stock_value,
    })),
    page,
    pageSize,
    total,
    hasMore: offset + rows.rows.length < total,
    totalValue,
    // `count(*)` comes back as a bigint string; the contract says a number, so it is converted here.
    unvaluedCount: Number(summary.rows[0]?.unvalued ?? 0),
  };
}
