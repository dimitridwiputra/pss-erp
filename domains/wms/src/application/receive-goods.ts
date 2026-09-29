import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { receiveStock } from '@pss/inventory';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from './support/with-connection';

const ReceiveGoodsLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qty: DecimalStringSchema });

const ReceiveGoodsInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  locationCode: z.string().min(1),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(ReceiveGoodsLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});
export type ReceiveGoodsInput = z.input<typeof ReceiveGoodsInputSchema>;

/**
 * WMS-003 (no-PO simplification, OD-136 — see `@pss/inventory`'s `receiveStock` and this domain's
 * DOMAIN.md): scans goods directly into a RECEIVING location (identified by its scanned
 * `locationCode`, resolved to an id server-side — same convention as `putawayStock`/
 * `confirmPickTask`) and posts the financial receipt in the same transaction (the full spec
 * instead requires `procurement.PostGoodsReceipt` first, since `procurement` does not exist yet).
 * Each line becomes one COMPLETED `RECEIVE` `WarehouseTask` — there is no separate assign/confirm
 * step here because there is no PO to check the scan against yet (WMS-003.R01/BR01's
 * PO-tolerance checks are therefore out of scope for this slice).
 */
export async function receiveGoods(pool: Pool, client: PoolClient | undefined, input: ReceiveGoodsInput): Promise<{ receiveTaskIds: string[]; putawayTaskIds: string[] }> {
  const parsed = ReceiveGoodsInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ receiveTaskIds: string[]; putawayTaskIds: string[] }> => {
    const tx = transaction.client;

    const location = await tx.query<{ id: string; type: string; status: string }>(`SELECT id, type, status FROM wms.warehouse_location WHERE warehouse_id = $1 AND code = $2`, [parsed.warehouseId, parsed.locationCode]);
    const locationRow = location.rows[0];
    if (!locationRow) throw new DomainError('NOT_FOUND');
    if (locationRow.type !== 'RECEIVING') throw new DomainError('LOCATION_INVALID');
    if (locationRow.status !== 'ACTIVE') throw new DomainError('LOCATION_UNAVAILABLE');
    const locationId = locationRow.id;

    const receiveTaskIds: string[] = [];
    const putawayTaskIds: string[] = [];
    for (const line of parsed.lines) {
      await tx.query(
        `INSERT INTO wms.physical_stock (id, organization_id, warehouse_id, location_id, product_id, uom, qty_on_hand, qty_allocated, version)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 1)
         ON CONFLICT (location_id, product_id) DO NOTHING`,
        [randomUUID(), parsed.organizationId, parsed.warehouseId, locationId, line.productId, line.uom],
      );
      await tx.query(
        `UPDATE wms.physical_stock SET qty_on_hand = qty_on_hand + $1::numeric, version = version + 1, updated_at = now()
         WHERE location_id = $2 AND product_id = $3`,
        [line.qty, locationId, line.productId],
      );

      const taskId = randomUUID();
      receiveTaskIds.push(taskId);
      await tx.query(
        `INSERT INTO wms.warehouse_task (
           id, organization_id, warehouse_id, type, status, reference_type, reference_id,
           location_id, product_id, uom, qty_expected, qty_confirmed
         ) VALUES ($1, $2, $3, 'RECEIVE', 'COMPLETED', $4, $5, $6, $7, $8, $9, $9)`,
        [taskId, parsed.organizationId, parsed.warehouseId, parsed.referenceType, parsed.referenceId, locationId, line.productId, line.uom, line.qty],
      );

      // WMS-003.AC01: a receipt creates a putaway task so the goods leave RECEIVING for a bin.
      const putawayTaskId = randomUUID();
      putawayTaskIds.push(putawayTaskId);
      await tx.query(
        `INSERT INTO wms.warehouse_task (
           id, organization_id, warehouse_id, type, status, reference_type, reference_id,
           location_id, product_id, uom, qty_expected
         ) VALUES ($1, $2, $3, 'PUTAWAY', 'CREATED', $4, $5, $6, $7, $8, $9)`,
        [putawayTaskId, parsed.organizationId, parsed.warehouseId, parsed.referenceType, parsed.referenceId, locationId, line.productId, line.uom, line.qty],
      );
    }

    await receiveStock(pool, tx, {
      organizationId: parsed.organizationId,
      warehouseId: parsed.warehouseId,
      referenceType: parsed.referenceType,
      referenceId: parsed.referenceId,
      lines: parsed.lines,
    });

    const auditContext = resolveAuditContext(parsed, parsed.referenceId);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'GOODS_RECEIVED_PHYSICAL',
      entity: { domain: 'wms', type: 'WarehouseTask', id: parsed.referenceId, version: 1 },
      changes: parsed.lines.map((line, index) => ({ path: `lines[${index}].qtyReceived`, classification: 'INTERNAL' as const, after: line.qty })),
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { receiveTaskIds, putawayTaskIds };
  };

  return withConnection(pool, client, work);
}
