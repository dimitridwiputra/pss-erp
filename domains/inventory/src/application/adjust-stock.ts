import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from '@pss/platform';

// Signed decimal: a discrepancy can be a surplus (+) or a shortage (-).
const SignedDecimalStringSchema = z.string().regex(/^-?\d+(\.\d{1,3})?$/);

const AdjustStockLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qtyDelta: SignedDecimalStringSchema, reasonCode: z.string().min(1) });

const AdjustStockInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(AdjustStockLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});
export type AdjustStockInput = z.input<typeof AdjustStockInputSchema>;

/**
 * WMS-010/011 (simplified): applies a signed quantity correction directly — the full INV-006
 * spec routes this through an approval workflow (`StockAdjustment` REQUESTED → APPROVED →
 * POSTED) before the ledger moves; that workflow does not exist yet, so this command applies
 * immediately and is intentionally named/scoped as the "POSTED" effect only. Approval gating
 * is tracked as an open decision in `domains/wms`'s DOMAIN.md, not silently skipped.
 */
export async function adjustStock(pool: Pool, client: PoolClient | undefined, input: AdjustStockInput): Promise<{ movementIds: string[] }> {
  const parsed = AdjustStockInputSchema.parse(input);

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
      const updated = await tx.query(
        `UPDATE inventory.stock_balance SET qty_on_hand = qty_on_hand + $1::numeric, version = version + 1, updated_at = now()
         WHERE warehouse_id = $2 AND product_id = $3 AND qty_on_hand + $1::numeric >= qty_reserved
         RETURNING id`,
        [line.qtyDelta, parsed.warehouseId, line.productId],
      );
      if (updated.rowCount === 0) {
        throw new DomainError('VALIDATION_FAILED', [], [{ path: 'lines', code: 'below_reserved', message: 'Penyesuaian membuat stok di bawah yang sudah dicadangkan.' }]);
      }
      const movementId = randomUUID();
      movementIds.push(movementId);
      await tx.query(
        `INSERT INTO inventory.stock_movement (
           id, organization_id, warehouse_id, product_id, uom, qty, movement_type, reference_type, reference_id
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ADJUSTMENT', $7, $8)`,
        [movementId, parsed.organizationId, parsed.warehouseId, line.productId, line.uom, line.qtyDelta, parsed.referenceType, parsed.referenceId],
      );
    }

    const auditContext = resolveAuditContext(parsed, parsed.referenceId);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'INVENTORY_ADJUSTED',
      entity: { domain: 'inventory', type: 'StockMovement', id: parsed.referenceId, version: 1 },
      changes: parsed.lines.map((line, index) => ({ path: `lines[${index}].qtyDelta`, classification: 'INTERNAL' as const, after: line.qtyDelta })),
      reasonCode: parsed.lines[0]?.reasonCode,
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { movementIds };
  };

  return withConnection(pool, client, work);
}
