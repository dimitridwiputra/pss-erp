import { randomUUID } from 'node:crypto';
import { runAuditedWork, withAuditedTransaction, type AuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

// Matches sales.delivery_order_line.qty_ordered: numeric(18,3), and the DB CHECK
// requires qty_ordered > 0, so the positive refinement mirrors that at the edge.
const PositiveQtySchema = z.string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Kuantitas harus berupa angka desimal maksimal 3 digit.')
  .refine((value) => Number(value) > 0, 'Kuantitas harus lebih besar dari nol.');

const ReleaseFulfillmentLineInputSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  qty: PositiveQtySchema,
});

const ReleaseFulfillmentInputSchema = z.strictObject({
  organizationId: z.uuid(),
  salesOrderId: z.uuid(),
  warehouseId: z.uuid(),
  lines: z.array(ReleaseFulfillmentLineInputSchema).min(1),
});

export type ReleaseFulfillmentInput = z.input<typeof ReleaseFulfillmentInputSchema>;

export interface ReleasedFulfillment {
  fulfillmentRequestId: string;
  deliveryOrderId: string;
}

/**
 * Releases one fulfillment request with a single customer-pickup delivery order.
 *
 * This slice is pickup-only: `handover_mode` is always `CUSTOMER_PICKUP`.
 * Delivery/dispatch, driver/WMS pick integration, and short/backorder decisioning
 * are future work (FUL-001..005) and are not implemented here.
 *
 * Releasing a fulfillment request is a system-triggered fact (e.g. from an order
 * confirmation workflow), not an action a human operator types in directly, so the
 * audit actor recorded here is a service identity rather than a userId. This
 * narrow slice's input also carries no request/correlation context from an
 * upstream HTTP layer yet, so both identifiers are minted locally.
 */
export async function releaseFulfillment(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ReleaseFulfillmentInput,
): Promise<ReleasedFulfillment> {
  const parsed = ReleaseFulfillmentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  const input = parsed.data;

  const work = async (transaction: AuditedTransaction): Promise<ReleasedFulfillment> => {
    const fulfillmentRequestId = randomUUID();
    const deliveryOrderId = randomUUID();

    await transaction.client.query(
      `INSERT INTO sales.fulfillment_request (id, organization_id, sales_order_id, warehouse_id, status)
       VALUES ($1, $2, $3, $4, 'RELEASED')`,
      [fulfillmentRequestId, input.organizationId, input.salesOrderId, input.warehouseId],
    );

    await transaction.client.query(
      `INSERT INTO sales.delivery_order (id, organization_id, fulfillment_request_id, handover_mode, status)
       VALUES ($1, $2, $3, 'CUSTOMER_PICKUP', 'PREPARED')`,
      [deliveryOrderId, input.organizationId, fulfillmentRequestId],
    );

    for (const line of input.lines) {
      await transaction.client.query(
        `INSERT INTO sales.delivery_order_line (id, delivery_order_id, product_id, uom, qty_ordered, qty_delivered)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [randomUUID(), deliveryOrderId, line.productId, line.uom, line.qty],
      );
    }

    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: { serviceIdentity: 'fulfillment.releaseFulfillment', roles: ['SYSTEM'] },
      action: 'FULFILLMENT_RELEASED',
      entity: { domain: 'fulfillment', type: 'FulfillmentRequest', id: fulfillmentRequestId, version: 1 },
      changes: [
        { path: 'status', classification: 'PUBLIC', after: 'RELEASED' },
        { path: 'salesOrderId', classification: 'PUBLIC', after: input.salesOrderId },
        { path: 'warehouseId', classification: 'PUBLIC', after: input.warehouseId },
      ],
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: 'SYSTEM',
    });

    return { fulfillmentRequestId, deliveryOrderId };
  };

  return client ? runAuditedWork(client, work) : withAuditedTransaction(pool, work);
}
