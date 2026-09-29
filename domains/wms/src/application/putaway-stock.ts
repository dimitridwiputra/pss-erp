import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from './support/with-connection';

const PutawayStockInputSchema = z.strictObject({
  taskId: z.uuid(),
  toLocationCode: z.string().min(1),
  qtyConfirmed: DecimalStringSchema,
  ...OptionalAuditContextSchema.shape,
});
export type PutawayStockInput = z.input<typeof PutawayStockInputSchema>;

/**
 * WMS-004: confirms a PUTAWAY task created by `receiveGoods`, moving physical stock out of
 * RECEIVING (or wherever the task's `location_id` points) into the scanned `toLocationCode` bin —
 * a code, not an id, since that is what an operator's handheld scanner actually reads off a
 * location's QR label (same convention as `confirmPickTask`'s `scannedLocationCode`). An unknown
 * code throws `NOT_FOUND`. WMS-004.BR01: never touches the financial balance — this only moves
 * rows in `wms.physical_stock`. Condition-based routing to QUARANTINE (WMS-004.BR02) is deferred —
 * this slice does not track stock condition yet (see DOMAIN.md open decisions).
 */
export async function putawayStock(pool: Pool, client: PoolClient | undefined, input: PutawayStockInput): Promise<{ taskId: string; status: string }> {
  const parsed = PutawayStockInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ taskId: string; status: string }> => {
    const tx = transaction.client;

    const task = await tx.query<{
      organization_id: string; warehouse_id: string; status: string; location_id: string; product_id: string; uom: string; qty_expected: string;
    }>(`SELECT organization_id, warehouse_id, status, location_id, product_id, uom, qty_expected FROM wms.warehouse_task WHERE id = $1 AND type = 'PUTAWAY' FOR UPDATE`, [parsed.taskId]);
    const taskRow = task.rows[0];
    if (!taskRow) throw new DomainError('NOT_FOUND');
    if (!['CREATED', 'ASSIGNED', 'IN_PROGRESS'].includes(taskRow.status)) throw new DomainError('INVALID_STATE_TRANSITION');
    if (Number(parsed.qtyConfirmed) > Number(taskRow.qty_expected)) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'qtyConfirmed', code: 'exceeds_task_qty', message: 'Qty putaway melebihi qty tugas.' }]);
    }

    const destination = await tx.query<{ id: string; status: string }>(`SELECT id, status FROM wms.warehouse_location WHERE warehouse_id = $1 AND code = $2`, [taskRow.warehouse_id, parsed.toLocationCode]);
    const destinationRow = destination.rows[0];
    if (!destinationRow) throw new DomainError('NOT_FOUND');
    if (destinationRow.status !== 'ACTIVE') throw new DomainError('LOCATION_UNAVAILABLE');

    const decremented = await tx.query(
      `UPDATE wms.physical_stock SET qty_on_hand = qty_on_hand - $1::numeric, version = version + 1, updated_at = now()
       WHERE location_id = $2 AND product_id = $3 AND qty_on_hand - qty_allocated >= $1::numeric
       RETURNING id`,
      [parsed.qtyConfirmed, taskRow.location_id, taskRow.product_id],
    );
    if (decremented.rowCount === 0) throw new DomainError('INSUFFICIENT_STOCK');

    await tx.query(
      `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 1)
       ON CONFLICT (location_id, product_id) DO UPDATE SET qty_on_hand = wms.physical_stock.qty_on_hand + $7::numeric, version = wms.physical_stock.version + 1, updated_at = now()`,
      [randomUUID(), taskRow.organization_id, taskRow.warehouse_id, destinationRow.id, taskRow.product_id, taskRow.uom, parsed.qtyConfirmed],
    );

    const status = Number(parsed.qtyConfirmed) < Number(taskRow.qty_expected) ? 'COMPLETED_SHORT' : 'COMPLETED';
    await tx.query(
      `UPDATE wms.warehouse_task SET status = $2, to_location_id = $3, qty_confirmed = $4, version = version + 1, updated_at = now() WHERE id = $1`,
      [parsed.taskId, status, destinationRow.id, parsed.qtyConfirmed],
    );

    const auditContext = resolveAuditContext(parsed, parsed.taskId);
    await transaction.appendAuditEntry({
      organizationId: taskRow.organization_id,
      actor: auditContext.actor,
      action: 'PUTAWAY_COMPLETED',
      entity: { domain: 'wms', type: 'WarehouseTask', id: parsed.taskId, version: 2 },
      changes: [
        { path: 'status', classification: 'INTERNAL' as const, before: taskRow.status, after: status },
        { path: 'toLocationCode', classification: 'INTERNAL' as const, after: parsed.toLocationCode },
      ],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { taskId: parsed.taskId, status };
  };

  return withConnection(pool, client, work);
}
