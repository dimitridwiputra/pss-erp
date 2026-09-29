import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DomainError, type FieldError } from '@pss/contracts';
import { getStockBalances } from '@pss/inventory';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from './support/with-connection';

const ActivateWarehouseInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  ...OptionalAuditContextSchema.shape,
});
export type ActivateWarehouseInput = z.input<typeof ActivateWarehouseInputSchema>;

/**
 * WMS-002 (simplified): the full spec drives activation off an opening cycle-count sweep across
 * every location, reconciled per (SKU, lot, condition) via a review/approval workflow. Lot/
 * condition dimensions and the review step do not exist yet in this build, so this command applies
 * the same underlying invariant (WMS-002.BR01: "activation only if physical == financial") as a
 * direct, per-product check: Σ `wms.physical_stock.qty_on_hand` for the warehouse must equal
 * `inventory`'s `qty_on_hand` for every product that has either a physical or financial balance.
 * A mismatch throws `WMS_ACTIVATION_BLOCKED` with one field error per product still out of sync —
 * the operator is expected to reconcile it via `submitCycleCount`/`resolveStockDiscrepancy` first
 * (see DOMAIN.md open decisions for what this does not yet cover: lot/expiry, per-condition
 * comparison, and the supervisor review step).
 */
export async function activateWarehouse(pool: Pool, client: PoolClient | undefined, input: ActivateWarehouseInput): Promise<{ warehouseId: string; activatedAt: string }> {
  const parsed = ActivateWarehouseInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ warehouseId: string; activatedAt: string }> => {
    const tx = transaction.client;

    const physical = await tx.query<{ product_id: string; qty: string }>(
      `SELECT product_id, SUM(qty_on_hand)::text AS qty FROM wms.physical_stock WHERE warehouse_id = $1 GROUP BY product_id`,
      [parsed.warehouseId],
    );
    const physicalByProduct = new Map(physical.rows.map((row) => [row.product_id, row.qty]));

    const financial = await getStockBalances(pool, tx, { warehouseId: parsed.warehouseId });
    const financialByProduct = new Map(financial.map((row) => [row.productId, row.qtyOnHand]));

    const productIds = new Set([...physicalByProduct.keys(), ...financialByProduct.keys()]);
    const mismatches: FieldError[] = [];
    for (const productId of productIds) {
      const physicalQty = physicalByProduct.get(productId) ?? '0.000';
      const financialQty = financialByProduct.get(productId) ?? '0.000';
      if (Number(physicalQty) !== Number(financialQty)) {
        mismatches.push({ path: `products[${productId}]`, code: 'physical_financial_mismatch', message: `Fisik ${physicalQty} vs finansial ${financialQty}.` });
      }
    }
    if (mismatches.length > 0) throw new DomainError('WMS_ACTIVATION_BLOCKED', [], mismatches);

    const result = await tx.query<{ activated_at: string }>(
      `INSERT INTO wms.warehouse_config (organization_id, warehouse_id, wms_enabled, activated_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (warehouse_id) DO UPDATE SET wms_enabled = true, activated_at = now(), updated_at = now()
       RETURNING activated_at`,
      [parsed.organizationId, parsed.warehouseId],
    );

    const auditContext = resolveAuditContext(parsed, parsed.warehouseId);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'WMS_ENABLED_CHANGED',
      entity: { domain: 'wms', type: 'WarehouseConfig', id: parsed.warehouseId, version: 1 },
      changes: [{ path: 'wmsEnabled', classification: 'INTERNAL' as const, before: false, after: true }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { warehouseId: parsed.warehouseId, activatedAt: result.rows[0]!.activated_at };
  };

  return withConnection(pool, client, work);
}
