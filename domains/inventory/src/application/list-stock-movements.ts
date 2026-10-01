import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '@pss/contracts';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** The three `stock_movement.movement_type` values the ledger accepts. */
const MovementTypeSchema = z.enum(['RECEIVE', 'ISSUE', 'ADJUSTMENT']);

const ListStockMovementsInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid().optional(),
  productId: z.uuid().optional(),
  /**
   * Restrict to these products. This is how a **search by name** reaches the ledger: `core.product` is
   * `master-data`'s table, so the API layer resolves the ids that match and passes them here
   * (AGENTS.md §3.1). An empty array matches nothing, so a search that found no product returns an
   * empty ledger rather than every movement in the warehouse.
   */
  productIds: z.array(z.uuid()).optional(),
  movementType: MovementTypeSchema.optional(),
  reasonCode: z.string().min(1).max(64).optional(),
  page: z.number().int().positive().max(10_000).optional(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  sort: z.enum(['occurredAt', 'qty', 'value']).optional(),
});

export type ListStockMovementsInput = z.input<typeof ListStockMovementsInputSchema>;

export interface StockMovementListItem {
  movementId: string;
  warehouseId: string;
  productId: string;
  uom: string;
  movementType: 'RECEIVE' | 'ISSUE' | 'ADJUSTMENT';
  /** Signed for an adjustment (a shortage is negative), positive otherwise. */
  qty: string;
  referenceType: string;
  referenceId: string;
  /** Only on an adjustment. */
  reasonCode: string | null;
  /** The reason's Indonesian label, or null when the movement has no reason. */
  reasonLabel: string | null;
  unitCost: string | null;
  totalCost: string | null;
  /** The movement's own timestamp, so the screen orders by the same clock the ledger wrote. */
  occurredAt: string;
}

export interface StockMovementPage {
  items: StockMovementListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

const SORT_COLUMNS = { occurredAt: 'm.created_at', qty: 'm.qty', value: 'm.total_cost' } as const;

/**
 * The movement ledger, newest first, for the Stok screen's history and for reconciliation.
 *
 * The reason label is joined from this domain's own `stock_adjustment_reason`; the product's name and
 * SKU are `master-data`'s facts and are deliberately absent, so a caller that needs them asks
 * `master-data` for them rather than this domain reaching into another schema (AGENTS.md §3.1).
 *
 * `occurredAt` is the movement's `created_at`, not the business date on the event: an event's business
 * date is the day the document belongs to, while the ledger's timestamp is when the row was written,
 * and a backdated receipt shows both.
 */
export async function listStockMovements(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ListStockMovementsInput,
): Promise<StockMovementPage> {
  const input = parseCommandInput(ListStockMovementsInputSchema, rawInput);
  const runner = client ?? pool;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortColumn = SORT_COLUMNS[input.sort ?? 'occurredAt'];
  // The default ledger view is newest first, and the id tiebreak follows it: a movement id is a uuid
  // v7, so two rows written in the same millisecond still come back in the order they were written.
  const newest = (input.sort ?? 'occurredAt') === 'occurredAt';

  const conditions = ['m.organization_id = $1'];
  const values: unknown[] = [input.organizationId];
  if (input.warehouseId) {
    values.push(input.warehouseId);
    conditions.push(`m.warehouse_id = $${values.length}`);
  }
  if (input.productId) {
    values.push(input.productId);
    conditions.push(`m.product_id = $${values.length}`);
  }
  if (input.productIds) {
    if (input.productIds.length === 0) {
      return { items: [], page, pageSize, total: 0, hasMore: false };
    }
    values.push(input.productIds);
    conditions.push(`m.product_id = ANY($${values.length}::uuid[])`);
  }
  if (input.movementType) {
    values.push(input.movementType);
    conditions.push(`m.movement_type = $${values.length}`);
  }
  if (input.reasonCode) {
    values.push(input.reasonCode);
    conditions.push(`m.reason_code = $${values.length}`);
  }
  const where = conditions.join(' AND ');

  const counted = await runner.query<{ total: string }>(
    `SELECT count(*) AS total FROM inventory.stock_movement m WHERE ${where}`, values,
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  const offset = (page - 1) * pageSize;

  const rows = await runner.query<{
    id: string; warehouse_id: string; product_id: string; uom: string; movement_type: 'RECEIVE' | 'ISSUE' | 'ADJUSTMENT';
    qty: string; reference_type: string; reference_id: string; reason_code: string | null; reason_label: string | null;
    unit_cost: string | null; total_cost: string | null; created_at: Date;
  }>(
    `SELECT m.id, m.warehouse_id, m.product_id, m.uom, m.movement_type, m.qty,
            m.reference_type, m.reference_id, m.reason_code, r.label AS reason_label,
            m.unit_cost, m.total_cost, m.created_at
     FROM inventory.stock_movement m
     LEFT JOIN inventory.stock_adjustment_reason r ON r.code = m.reason_code
     WHERE ${where}
     ORDER BY ${sortColumn} ${newest ? 'DESC' : 'ASC'}, m.id ${newest ? 'DESC' : 'ASC'}
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset],
  );

  return {
    items: rows.rows.map((row) => ({
      movementId: row.id,
      warehouseId: row.warehouse_id,
      productId: row.product_id,
      uom: row.uom,
      movementType: row.movement_type,
      qty: row.qty,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      reasonCode: row.reason_code,
      reasonLabel: row.reason_label,
      unitCost: row.unit_cost,
      totalCost: row.total_cost,
      occurredAt: row.created_at.toISOString(),
    })),
    page,
    pageSize,
    total,
    hasMore: offset + rows.rows.length < total,
  };
}
