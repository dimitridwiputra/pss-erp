import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from './support/with-connection';

const SubmitCycleCountInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  locationCode: z.string().min(1),
  productId: z.uuid(),
  uom: z.string().min(1),
  countedQty: DecimalStringSchema,
  ...OptionalAuditContextSchema.shape,
});
export type SubmitCycleCountInput = z.input<typeof SubmitCycleCountInputSchema>;

export interface CycleCountResult {
  taskId: string;
  varianceDetected: boolean;
  discrepancyReportId?: string;
}

/**
 * WMS-010 (blind count): WMS-010.BR01 — the system qty is never shown to the counter, so this
 * command deliberately never returns it (nor the signed variance) — only whether a variance was
 * found. It does not overwrite `wms.physical_stock` itself either: that would apply the count
 * unilaterally, skipping the review step the real spec requires (WMS-010's
 * PLANNED -> COUNTING -> SUBMITTED -> REVIEWED -> POSTED). Instead a variance opens a
 * `stock_discrepancy_report` (REPORTED) for `resolveStockDiscrepancy` to apply — the same single
 * path WMS-011's ad hoc "Laporkan Masalah" reports go through. The supervisor-review /
 * different-counter-for-recount steps (WMS-010.BR02/BR03) are not implemented in this slice
 * (see DOMAIN.md open decisions).
 */
export async function submitCycleCount(pool: Pool, client: PoolClient | undefined, input: SubmitCycleCountInput): Promise<CycleCountResult> {
  const parsed = SubmitCycleCountInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<CycleCountResult> => {
    const tx = transaction.client;

    const location = await tx.query<{ id: string; status: string }>(`SELECT id, status FROM wms.warehouse_location WHERE warehouse_id = $1 AND code = $2`, [parsed.warehouseId, parsed.locationCode]);
    const locationRow = location.rows[0];
    if (!locationRow) throw new DomainError('NOT_FOUND');
    const locationId = locationRow.id;

    const existingStock = await tx.query<{ qty_on_hand: string }>(`SELECT qty_on_hand FROM wms.physical_stock WHERE location_id = $1 AND product_id = $2`, [locationId, parsed.productId]);
    const systemQty = existingStock.rows[0]?.qty_on_hand ?? '0.000';
    const variance = Number(parsed.countedQty) - Number(systemQty);
    const varianceDetected = Math.abs(variance) > 1e-9;

    const taskId = randomUUID();
    await tx.query(
      `INSERT INTO wms.warehouse_task (
         id, organization_id, warehouse_id, type, status, location_id, product_id, uom, qty_expected, qty_confirmed
       ) VALUES ($1, $2, $3, 'COUNT', 'COMPLETED', $4, $5, $6, $7, $8)`,
      [taskId, parsed.organizationId, parsed.warehouseId, locationId, parsed.productId, parsed.uom, systemQty, parsed.countedQty],
    );

    let discrepancyReportId: string | undefined;
    if (varianceDetected) {
      discrepancyReportId = randomUUID();
      const reportType = variance > 0 ? 'EXCESS' : 'MISSING';
      const reasonCode = variance > 0 ? 'RC-WMS-DISC_EXCESS' : 'RC-WMS-DISC_MISSING';
      await tx.query(
        `INSERT INTO wms.stock_discrepancy_report (
           id, organization_id, warehouse_id, location_id, product_id, uom, report_type, qty, reason_code,
           evidence_media_ids, status, reported_by, source_task_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[]'::jsonb, 'REPORTED', $10, $11)`,
        [discrepancyReportId, parsed.organizationId, parsed.warehouseId, locationId, parsed.productId, parsed.uom, reportType, Math.abs(variance).toFixed(3), reasonCode, parsed.actor?.userId ?? null, taskId],
      );
    }

    const auditContext = resolveAuditContext(parsed, taskId);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'CYCLE_COUNT_SUBMITTED',
      entity: { domain: 'wms', type: 'WarehouseTask', id: taskId, version: 1 },
      changes: [{ path: 'countedQty', classification: 'INTERNAL' as const, after: parsed.countedQty }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return discrepancyReportId ? { taskId, varianceDetected, discrepancyReportId } : { taskId, varianceDetected };
  };

  return withConnection(pool, client, work);
}
