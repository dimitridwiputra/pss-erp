import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { getStockBalances } from '@pss/inventory';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from './support/with-connection';

const RunReconciliationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  businessDate: z.iso.date(),
  ...OptionalAuditContextSchema.shape,
});
export type RunReconciliationInput = z.input<typeof RunReconciliationInputSchema>;

export interface ReconciliationItem {
  productId: string;
  physicalQty: string;
  financialQty: string;
  variance: string;
}

export interface ReconciliationResult {
  id: string;
  warehouseId: string;
  businessDate: string;
  varianceCount: number;
  items: ReconciliationItem[];
}

/**
 * WMS-013 (REQ-130, simplified): compares Σ `wms.physical_stock` against `inventory`'s financial
 * balance per product for one warehouse, snapshotting the result. WMS-013.BR01's full comparison
 * key is (warehouse, SKU, lot, condition) — this slice compares per (warehouse, product) only,
 * the same simplification `activateWarehouse` already makes, since lot/condition are not tracked
 * yet (see DOMAIN.md open decisions). Idempotent per (warehouseId, businessDate) — a second run
 * for a date already reconciled returns the original, immutable result rather than recomputing
 * (WMS-013's "Hasil immutable"). Opening a `Q-INVENTORY_VARIANCE` queue item for a detected
 * variance is deferred — no queue/exception infrastructure exists yet to open it into.
 */
export async function runReconciliation(pool: Pool, client: PoolClient | undefined, input: RunReconciliationInput): Promise<ReconciliationResult> {
  const parsed = RunReconciliationInputSchema.parse(input);

  const runner = client ?? pool;
  const existing = await runner.query<{ id: string; variance_count: number; items: ReconciliationItem[] }>(
    `SELECT id, variance_count, items FROM wms.reconciliation_result WHERE warehouse_id = $1 AND business_date = $2`,
    [parsed.warehouseId, parsed.businessDate],
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    return { id: existingRow.id, warehouseId: parsed.warehouseId, businessDate: parsed.businessDate, varianceCount: existingRow.variance_count, items: existingRow.items };
  }

  const work = async (transaction: AuditedTransaction): Promise<ReconciliationResult> => {
    const tx = transaction.client;

    const physical = await tx.query<{ product_id: string; qty: string }>(
      `SELECT product_id, SUM(qty_on_hand)::text AS qty FROM wms.physical_stock WHERE warehouse_id = $1 GROUP BY product_id`,
      [parsed.warehouseId],
    );
    const physicalByProduct = new Map(physical.rows.map((row) => [row.product_id, row.qty]));

    const financial = await getStockBalances(pool, tx, { warehouseId: parsed.warehouseId });
    const financialByProduct = new Map(financial.map((row) => [row.productId, row.qtyOnHand]));

    const productIds = new Set([...physicalByProduct.keys(), ...financialByProduct.keys()]);
    const items: ReconciliationItem[] = [];
    for (const productId of productIds) {
      const physicalQty = physicalByProduct.get(productId) ?? '0.000';
      const financialQty = financialByProduct.get(productId) ?? '0.000';
      if (Number(physicalQty) !== Number(financialQty)) {
        items.push({ productId, physicalQty, financialQty, variance: (Number(physicalQty) - Number(financialQty)).toFixed(3) });
      }
    }

    // A concurrent call for the same (warehouseId, businessDate) racing past the pre-check above
    // is a rare, low-stakes edge case (two people triggering the same day's reconciliation at the
    // same instant) — it fails the UNIQUE constraint and rolls back rather than being silently
    // reconciled here, since recovering it would require returning without an audit entry, which
    // `runAuditedWork` rejects. The caller can simply retry the read (`getReconciliationResult`).
    const id = randomUUID();
    await tx.query(
      `INSERT INTO wms.reconciliation_result (id, organization_id, warehouse_id, business_date, variance_count, items)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [id, parsed.organizationId, parsed.warehouseId, parsed.businessDate, items.length, JSON.stringify(items)],
    );

    const auditContext = resolveAuditContext(parsed, id);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'WMS_RECONCILIATION_COMPLETED',
      entity: { domain: 'wms', type: 'ReconciliationResult', id, version: 1 },
      changes: [{ path: 'varianceCount', classification: 'INTERNAL' as const, after: String(items.length) }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { id, warehouseId: parsed.warehouseId, businessDate: parsed.businessDate, varianceCount: items.length, items };
  };

  return withConnection(pool, client, work);
}

const GetReconciliationResultInputSchema = z.strictObject({ warehouseId: z.uuid(), businessDate: z.iso.date() });
export type GetReconciliationResultInput = z.input<typeof GetReconciliationResultInputSchema>;

/** Read-only: the persisted result for one (warehouse, date), or null if it has not run yet. */
export async function getReconciliationResult(pool: Pool, input: GetReconciliationResultInput): Promise<ReconciliationResult | null> {
  const parsed = GetReconciliationResultInputSchema.parse(input);
  const result = await pool.query<{ id: string; variance_count: number; items: ReconciliationItem[] }>(
    `SELECT id, variance_count, items FROM wms.reconciliation_result WHERE warehouse_id = $1 AND business_date = $2`,
    [parsed.warehouseId, parsed.businessDate],
  );
  const row = result.rows[0];
  return row ? { id: row.id, warehouseId: parsed.warehouseId, businessDate: parsed.businessDate, varianceCount: row.variance_count, items: row.items } : null;
}
