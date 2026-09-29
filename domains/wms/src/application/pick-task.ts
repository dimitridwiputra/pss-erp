import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { issueInventory } from '@pss/inventory';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from '@pss/platform';

const GetNextWarehouseTaskInputSchema = z.strictObject({
  warehouseId: z.uuid(),
  type: z.enum(['RECEIVE', 'PUTAWAY', 'PICK', 'COUNT']),
  assigneeUserId: z.uuid(),
});
export type GetNextWarehouseTaskInput = z.input<typeof GetNextWarehouseTaskInputSchema>;

export interface NextWarehouseTask {
  id: string;
  locationCode: string;
  productId: string;
  uom: string;
  qtyExpected: string;
}

/**
 * WMS-006 "Tugas Berikutnya": the next open task of `type` for this warehouse, assigning it to
 * the requesting operator if it was unassigned. Read-only for an already-assigned-to-me task; a
 * small, single mutation (CREATED -> ASSIGNED) otherwise — kept out of `withConnection` because
 * that mutation is optional (no-op when the next task is already mine) and would otherwise trip
 * `runAuditedWork`'s "must audit" guard on the read-only path.
 */
export async function getNextWarehouseTask(pool: Pool, input: GetNextWarehouseTaskInput): Promise<NextWarehouseTask | null> {
  const parsed = GetNextWarehouseTaskInputSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const next = await client.query<{ id: string; location_code: string; product_id: string; uom: string; qty_expected: string; status: string }>(
      `SELECT t.id, wl.code AS location_code, t.product_id, t.uom, t.qty_expected, t.status
       FROM wms.warehouse_task t
       JOIN wms.warehouse_location wl ON wl.id = t.location_id
       WHERE t.warehouse_id = $1 AND t.type = $2 AND t.status IN ('CREATED', 'ASSIGNED', 'IN_PROGRESS')
         AND (t.assignee_user_id IS NULL OR t.assignee_user_id = $3)
       ORDER BY t.created_at ASC
       LIMIT 1
       FOR UPDATE OF t`,
      [parsed.warehouseId, parsed.type, parsed.assigneeUserId],
    );
    const row = next.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    if (row.status === 'CREATED') {
      await client.query(`UPDATE wms.warehouse_task SET status = 'ASSIGNED', assignee_user_id = $2, version = version + 1, updated_at = now() WHERE id = $1`, [row.id, parsed.assigneeUserId]);
    }
    await client.query('COMMIT');
    return { id: row.id, locationCode: row.location_code, productId: row.product_id, uom: row.uom, qtyExpected: row.qty_expected };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ConfirmPickTaskInputSchema = z.strictObject({
  taskId: z.uuid(),
  scannedLocationCode: z.string().min(1),
  scannedProductId: z.uuid(),
  qtyConfirmed: DecimalStringSchema,
  shortReasonCode: z.string().min(1).optional(),
  ...OptionalAuditContextSchema.shape,
});
export type ConfirmPickTaskInput = z.input<typeof ConfirmPickTaskInputSchema>;

/**
 * WMS-006: SCAN -> CONFIRM -> NEXT. WMS-000.R02/WMS-006.R01: a scan that does not match the
 * task's expected location or product is rejected with `SCAN_MISMATCH` *before* any state
 * changes — checked first, ahead of every other guard. WMS-006.BR01: qty confirmed must not
 * exceed the task's qty; WMS-006.BR02: a short pick (qtyConfirmed < qtyExpected) requires a
 * reason code. On completion this issues the picked qty out of `inventory` (financial dispatch,
 * reusing the same `issueInventory` POS-010 uses at pickup handover) and releases the task's
 * `qty_allocated` claim.
 *
 * Precondition callers must satisfy: `issueInventory` requires an existing ACTIVE
 * `inventory.stock_reservation` for `(task.referenceType, task.referenceId, task.productId)` —
 * this domain never creates that reservation itself. In the real flow, WMS-005 allocation is
 * triggered by `FULFILLMENT_RELEASED`, which only happens after the caller (e.g. POS's checkout)
 * already reserved that same reference financially (DEC-108: WMS calls public commands the same
 * way other domains do). `allocatePickTask`'s `referenceId` must therefore be the same id that
 * reservation was made against.
 */
export async function confirmPickTask(pool: Pool, client: PoolClient | undefined, input: ConfirmPickTaskInput): Promise<{ taskId: string; status: string }> {
  const parsed = ConfirmPickTaskInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ taskId: string; status: string }> => {
    const tx = transaction.client;

    const task = await tx.query<{
      organization_id: string; warehouse_id: string; status: string; location_id: string; location_code: string;
      product_id: string; uom: string; qty_expected: string; reference_type: string; reference_id: string;
    }>(
      `SELECT t.organization_id, t.warehouse_id, t.status, t.location_id, wl.code AS location_code,
              t.product_id, t.uom, t.qty_expected, t.reference_type, t.reference_id
       FROM wms.warehouse_task t JOIN wms.warehouse_location wl ON wl.id = t.location_id
       WHERE t.id = $1 AND t.type = 'PICK' FOR UPDATE OF t`,
      [parsed.taskId],
    );
    const taskRow = task.rows[0];
    if (!taskRow) throw new DomainError('NOT_FOUND');

    if (taskRow.location_code !== parsed.scannedLocationCode || taskRow.product_id !== parsed.scannedProductId) {
      throw new DomainError('SCAN_MISMATCH');
    }
    if (!['CREATED', 'ASSIGNED', 'IN_PROGRESS'].includes(taskRow.status)) throw new DomainError('INVALID_STATE_TRANSITION');
    if (Number(parsed.qtyConfirmed) > Number(taskRow.qty_expected)) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'qtyConfirmed', code: 'exceeds_task_qty', message: 'Qty pick melebihi qty tugas.' }]);
    }
    const isShort = Number(parsed.qtyConfirmed) < Number(taskRow.qty_expected);
    if (isShort && !parsed.shortReasonCode) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'shortReasonCode', code: 'required', message: 'Alasan diperlukan untuk pick kurang.' }]);
    }

    await tx.query(
      `UPDATE wms.physical_stock SET qty_on_hand = qty_on_hand - $1::numeric, qty_allocated = qty_allocated - $2::numeric, version = version + 1, updated_at = now()
       WHERE location_id = $3 AND product_id = $4`,
      [parsed.qtyConfirmed, taskRow.qty_expected, taskRow.location_id, taskRow.product_id],
    );

    const status = isShort ? 'COMPLETED_SHORT' : 'COMPLETED';
    await tx.query(
      `UPDATE wms.warehouse_task SET status = $2, qty_confirmed = $3, short_reason_code = $4, version = version + 1, updated_at = now() WHERE id = $1`,
      [parsed.taskId, status, parsed.qtyConfirmed, parsed.shortReasonCode ?? null],
    );

    if (Number(parsed.qtyConfirmed) > 0) {
      await issueInventory(pool, tx, {
        organizationId: taskRow.organization_id,
        warehouseId: taskRow.warehouse_id,
        referenceType: taskRow.reference_type,
        referenceId: taskRow.reference_id,
        lines: [{ productId: taskRow.product_id, uom: taskRow.uom, qty: parsed.qtyConfirmed }],
      });
    }

    const auditContext = resolveAuditContext(parsed, parsed.taskId);
    await transaction.appendAuditEntry({
      organizationId: taskRow.organization_id,
      actor: auditContext.actor,
      action: isShort ? 'PICK_COMPLETED_SHORT' : 'PICK_CONFIRMED',
      entity: { domain: 'wms', type: 'WarehouseTask', id: parsed.taskId, version: 2 },
      changes: [
        { path: 'status', classification: 'INTERNAL' as const, before: taskRow.status, after: status },
        { path: 'qtyConfirmed', classification: 'INTERNAL' as const, after: parsed.qtyConfirmed },
      ],
      reasonCode: parsed.shortReasonCode,
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { taskId: parsed.taskId, status };
  };

  return withConnection(pool, client, work);
}
