import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runAuditedWork } from '@pss/audit';
import { DecimalStringSchema } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';

const AllocatePickTaskLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qty: DecimalStringSchema });

const AllocatePickTaskInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(AllocatePickTaskLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});
export type AllocatePickTaskInput = z.input<typeof AllocatePickTaskInputSchema>;

export interface AllocatePickTaskResult {
  taskIds: string[];
  shortLines: Array<{ productId: string; requestedQty: string; allocatedQty: string }>;
}

/**
 * WMS-005 (simplified): the full spec allocates by FEFO (expiry) for expiry-managed products and
 * FIFO-by-lot otherwise; this build does not track lot/expiry on physical stock yet, so allocation
 * instead walks eligible locations ordered by location `code` (a stand-in for "oldest placement" —
 * documented as a simplification, not FEFO) and never allocates from a QUARANTINE or BLOCKED
 * location (WMS-005.BR01). `qty_allocated` prevents the same physical unit being claimed twice
 * (WMS-005.BR02).
 *
 * WMS-005.R01 idempotency: if PICK tasks already exist for (referenceType, referenceId), this is
 * a no-op that returns an empty result rather than allocating again. Since that path mutates
 * nothing, it is checked before opening the audited transaction — same reasoning as
 * `releaseReservation` in `@pss/inventory` (`runAuditedWork` rejects a callback that never
 * audits).
 */
export async function allocatePickTask(pool: Pool, client: PoolClient | undefined, input: AllocatePickTaskInput): Promise<AllocatePickTaskResult> {
  const parsed = AllocatePickTaskInputSchema.parse(input);
  const ownsClient = client === undefined;
  const tx = client ?? (await pool.connect());
  let begun = false;
  try {
    if (ownsClient) {
      await tx.query('BEGIN');
      begun = true;
    }

    const existing = await tx.query(`SELECT id FROM wms.warehouse_task WHERE type = 'PICK' AND reference_type = $1 AND reference_id = $2`, [parsed.referenceType, parsed.referenceId]);
    if ((existing.rowCount ?? 0) > 0) {
      if (ownsClient) await tx.query('COMMIT');
      return { taskIds: [], shortLines: [] };
    }

    const result = await runAuditedWork(tx, async (transaction) => {
      const taskIds: string[] = [];
      const shortLines: AllocatePickTaskResult['shortLines'] = [];

      for (const line of parsed.lines) {
        const available = await transaction.client.query<{ id: string; location_id: string; available: string }>(
          `SELECT ps.id, ps.location_id, (ps.qty_on_hand - ps.qty_allocated)::text AS available
           FROM wms.physical_stock ps
           JOIN wms.warehouse_location wl ON wl.id = ps.location_id
           WHERE ps.warehouse_id = $1 AND ps.product_id = $2 AND wl.type != 'QUARANTINE' AND wl.status = 'ACTIVE'
             AND (ps.qty_on_hand - ps.qty_allocated) > 0
           ORDER BY wl.code ASC
           FOR UPDATE OF ps`,
          [parsed.warehouseId, line.productId],
        );

        let remaining = Number(line.qty);
        for (const row of available.rows) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, Number(row.available));
          const takeText = take.toFixed(3);

          await transaction.client.query(
            `UPDATE wms.physical_stock SET qty_allocated = qty_allocated + $1::numeric, version = version + 1, updated_at = now() WHERE id = $2`,
            [takeText, row.id],
          );

          const taskId = randomUUID();
          taskIds.push(taskId);
          await transaction.client.query(
            `INSERT INTO wms.warehouse_task (
               id, organization_id, warehouse_id, type, status, reference_type, reference_id, location_id, product_id, uom, qty_expected
             ) VALUES ($1, $2, $3, 'PICK', 'CREATED', $4, $5, $6, $7, $8, $9)`,
            [taskId, parsed.organizationId, parsed.warehouseId, parsed.referenceType, parsed.referenceId, row.location_id, line.productId, line.uom, takeText],
          );

          remaining -= take;
        }

        if (remaining > 1e-9) {
          shortLines.push({ productId: line.productId, requestedQty: line.qty, allocatedQty: (Number(line.qty) - remaining).toFixed(3) });
        }
      }

      const auditContext = resolveAuditContext(parsed, parsed.referenceId);
      await transaction.appendAuditEntry({
        organizationId: parsed.organizationId,
        actor: auditContext.actor,
        action: shortLines.length > 0 ? 'ALLOCATION_SHORT' : 'ALLOCATION_COMPLETED',
        entity: { domain: 'wms', type: 'WarehouseTask', id: parsed.referenceId, version: 1 },
        changes: parsed.lines.map((line, index) => ({ path: `lines[${index}].qty`, classification: 'INTERNAL' as const, after: line.qty })),
        requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
      });

      return { taskIds, shortLines };
    });

    if (ownsClient) await tx.query('COMMIT');
    return result;
  } catch (error) {
    if (ownsClient && begun) await tx.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient) tx.release();
  }
}
