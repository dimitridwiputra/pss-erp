import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from '@pss/platform';

const ReceiveStockLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qty: DecimalStringSchema });

const ReceiveStockInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(ReceiveStockLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});
export type ReceiveStockInput = z.input<typeof ReceiveStockInputSchema>;

/**
 * WMS-003 (no-PO simplification, OD-136): increases on-hand stock directly. The full spec
 * routes receiving through `procurement.PostGoodsReceipt` (PO matching, cost capture) before
 * `inventory` ever sees it — `procurement` does not exist in this build, so this command is
 * called directly by `domains/wms`'s receiving flow instead. No unit cost/valuation is recorded
 * yet (see DOMAIN.md open decisions); this only moves quantity.
 */
export async function receiveStock(pool: Pool, client: PoolClient | undefined, input: ReceiveStockInput): Promise<{ movementIds: string[] }> {
  const parsed = ReceiveStockInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ movementIds: string[] }> => {
    const tx = transaction.client;
    const movementIds: string[] = [];

    for (const line of parsed.lines) {
      await tx.query(
        `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
         VALUES ($1, $2, $3, $4, $5, 0, 0, 1)
         ON CONFLICT (warehouse_id, product_id) DO NOTHING`,
        [randomUUID(), parsed.organizationId, parsed.warehouseId, line.productId, line.uom],
      );
      await tx.query(
        `UPDATE inventory.stock_balance SET qty_on_hand = qty_on_hand + $1::numeric, version = version + 1, updated_at = now()
         WHERE warehouse_id = $2 AND product_id = $3`,
        [line.qty, parsed.warehouseId, line.productId],
      );
      const movementId = randomUUID();
      movementIds.push(movementId);
      await tx.query(
        `INSERT INTO inventory.stock_movement (
           id, organization_id, warehouse_id, product_id, uom, qty, movement_type, reference_type, reference_id
         ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVE', $7, $8)`,
        [movementId, parsed.organizationId, parsed.warehouseId, line.productId, line.uom, line.qty, parsed.referenceType, parsed.referenceId],
      );
    }

    const auditContext = resolveAuditContext(parsed, parsed.referenceId);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'INVENTORY_RECEIVED',
      entity: { domain: 'inventory', type: 'StockMovement', id: parsed.referenceId, version: 1 },
      changes: parsed.lines.map((line, index) => ({ path: `lines[${index}].qtyReceived`, classification: 'INTERNAL' as const, after: line.qty })),
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { movementIds };
  };

  return withConnection(pool, client, work);
}
