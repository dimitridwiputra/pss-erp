import { randomUUID } from 'node:crypto';
import { DomainError, newEventId } from '@pss/contracts';
import { appendOutboxEvent, withConnection } from '@pss/platform';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

// Matches sales.delivery_order_line.qty_delivered/qty_ordered: numeric(18,3).
// Unlike the release-side qty, zero is a legal handed-over quantity here (a short
// pickup); the DB CHECK (qty_delivered <= qty_ordered) remains the final backstop.
const NonNegativeQtySchema = z.string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Kuantitas harus berupa angka desimal maksimal 3 digit.');

const ConfirmPickupHandoverLineInputSchema = z.strictObject({
  deliveryOrderLineId: z.uuid(),
  qtyHandedOver: NonNegativeQtySchema,
});

const ConfirmPickupHandoverInputSchema = z.strictObject({
  deliveryOrderId: z.uuid(),
  posSaleStatus: z.enum(['PAID', 'CREDIT_APPROVED', 'PENDING_PAYMENT', 'CART', 'CANCELLED', 'HANDED_OVER']),
  actorId: z.uuid(),
  tenderAcceptedBy: z.uuid().optional(),
  sodCashierNotHandoverEnabled: z.boolean(),
  lines: z.array(ConfirmPickupHandoverLineInputSchema).min(1),
  receiverName: z.string().min(1),
  mediaIds: z.array(z.string().min(1)).optional(),
  // The caller's request context, so the audit entry and DELIVERY_ORDER_DELIVERED correlate with
  // the request that caused them. Generated when absent, as before.
  requestId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
});

export type ConfirmPickupHandoverInput = z.input<typeof ConfirmPickupHandoverInputSchema>;

export interface ConfirmedPickupHandover {
  deliveryOrderId: string;
  status: 'DELIVERED' | 'PARTIALLY_DELIVERED';
}

const PAID_POS_SALE_STATUSES: ReadonlySet<string> = new Set(['PAID', 'CREDIT_APPROVED']);

/**
 * POS-010: confirms a customer-pickup handover at the counter.
 *
 * This command is guarded and security-sensitive, and the PRD names `fulfillment`
 * (not `pos`) as its domain owner even though the two facts it guards against —
 * the PosSale's payment status and who accepted the tender — live in the `pos`
 * schema. Per the no-cross-domain-DB-access rule, this command never reads
 * `pos.*` directly; the caller (`domains/pos`'s checkout/handover flow) passes
 * both facts in as plain parameters that it already knows server-side.
 */
export async function confirmPickupHandover(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ConfirmPickupHandoverInput,
): Promise<ConfirmedPickupHandover> {
  const parsed = ConfirmPickupHandoverInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  const input = parsed.data;

  // (a) EXCEPTION FLOW E1: goods can only be handed over once the sale is settled.
  if (!PAID_POS_SALE_STATUSES.has(input.posSaleStatus)) throw new DomainError('POS_NOT_PAID');

  // Pass an open `client` to compose with the caller: POS issues stock and the invoice in the same
  // commit (POS-010.R02), so a failure in any of them leaves none applied.
  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const orderResult = await client.query<{
      organization_id: string;
      status: string;
      version: number;
    }>(
      `SELECT organization_id, status, version FROM sales.delivery_order WHERE id = $1 FOR UPDATE`,
      [input.deliveryOrderId],
    );
    const order = orderResult.rows[0];
    if (!order) throw new DomainError('NOT_FOUND');
    // (b) Covers double-serve: only a PREPARED delivery order can be handed over.
    if (order.status !== 'PREPARED') throw new DomainError('POS_ALREADY_HANDED_OVER');

    // (c) SOD-09 / POS-000.R11: the cashier who accepted the tender cannot also
    // be the one who confirms the handover, when the policy flag is on.
    if (input.sodCashierNotHandoverEnabled && input.actorId === input.tenderAcceptedBy) {
      throw new DomainError('SEGREGATION_OF_DUTIES');
    }

    // (d) Validate and record each line's handed-over quantity.
    for (const [index, line] of input.lines.entries()) {
      const lineResult = await client.query<{ qty_ordered: string; within_ordered: boolean }>(
        `SELECT qty_ordered, (qty_ordered >= $3::numeric) AS within_ordered
         FROM sales.delivery_order_line
         WHERE id = $1 AND delivery_order_id = $2
         FOR UPDATE`,
        [line.deliveryOrderLineId, input.deliveryOrderId, line.qtyHandedOver],
      );
      const lineRow = lineResult.rows[0];
      if (!lineRow) {
        throw new DomainError('VALIDATION_FAILED', [], [{
          path: `lines.${index}.deliveryOrderLineId`,
          code: 'not_found',
          message: 'Periksa nilai ini.',
        }]);
      }
      if (!lineRow.within_ordered) {
        throw new DomainError('VALIDATION_FAILED', [], [{
          path: `lines.${index}.qtyHandedOver`,
          code: 'too_large',
          message: 'Periksa nilai ini.',
        }]);
      }
      await client.query(
        `UPDATE sales.delivery_order_line SET qty_delivered = $1 WHERE id = $2`,
        [line.qtyHandedOver, line.deliveryOrderLineId],
      );
    }

    // (e) A delivery order is DELIVERED only once every one of its lines (not just
    // the ones submitted this call) is fully handed over; anything short of that,
    // including a line this call left untouched, keeps it PARTIALLY_DELIVERED.
    const shortfall = await client.query<{ short_count: number }>(
      `SELECT count(*) FILTER (WHERE qty_delivered <> qty_ordered)::int AS short_count
       FROM sales.delivery_order_line WHERE delivery_order_id = $1`,
      [input.deliveryOrderId],
    );
    const status: 'DELIVERED' | 'PARTIALLY_DELIVERED' =
      (shortfall.rows[0]?.short_count ?? 0) === 0 ? 'DELIVERED' : 'PARTIALLY_DELIVERED';

    const updated = await client.query<{ version: number; delivered_at: Date }>(
      `UPDATE sales.delivery_order
       SET status = $1, delivered_at = now(), receiver_name = $2, updated_at = now(), version = version + 1
       WHERE id = $3
       RETURNING version, delivered_at`,
      [status, input.receiverName, input.deliveryOrderId],
    );
    const newVersion = updated.rows[0]?.version;
    if (newVersion === undefined) throw new Error('Delivery order update did not return a version.');

    // mediaIds has no dedicated storage in this slice (no photo/attachment table
    // exists yet), so it is captured as evidence in the audit trail rather than
    // silently discarded.
    const mediaChange = input.mediaIds && input.mediaIds.length > 0
      ? [{ path: 'mediaIds', classification: 'PUBLIC' as const, after: JSON.stringify(input.mediaIds) }]
      : [];

    const requestId = input.requestId ?? randomUUID();
    const correlationId = input.correlationId ?? requestId;
    await appendAuditEntry({
      organizationId: order.organization_id,
      actor: { userId: input.actorId, roles: [] },
      action: 'DELIVERY_ORDER_DELIVERED',
      entity: { domain: 'fulfillment', type: 'DeliveryOrder', id: input.deliveryOrderId, version: newVersion },
      changes: [
        { path: 'status', classification: 'PUBLIC', before: 'PREPARED', after: status },
        { path: 'receiverName', classification: 'PERSONAL', after: input.receiverName },
        ...input.lines.map((line, index) => ({
          path: `lines.${index}.qtyHandedOver`,
          classification: 'PUBLIC' as const,
          after: line.qtyHandedOver,
        })),
        ...mediaChange,
      ],
      requestId,
      correlationId,
      source: 'API',
    });

    if (status === 'DELIVERED') {
      const deliveredAt = updated.rows[0]!.delivered_at.toISOString();
      const lines = await client.query<{ product_id: string; qty_delivered: string }>(
        'SELECT product_id, qty_delivered FROM sales.delivery_order_line WHERE delivery_order_id = $1 ORDER BY id',
        [input.deliveryOrderId],
      );
      await appendOutboxEvent(client, {
        eventId: newEventId(), eventType: 'DELIVERY_ORDER_DELIVERED', eventVersion: 1,
        occurredAt: deliveredAt,
        businessDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(updated.rows[0]!.delivered_at),
        organizationId: order.organization_id,
        aggregateType: 'DeliveryOrder', aggregateId: input.deliveryOrderId, aggregateVersion: newVersion,
        producer: 'fulfillment', actor: { userId: input.actorId, roles: [] },
        correlationId, causationId: requestId,
        payload: {
          doId: input.deliveryOrderId, deliveredAt,
          lines: lines.rows.map((line) => ({ productId: line.product_id, qtyDelivered: line.qty_delivered })),
          source: 'ADMIN',
        },
      });
    }

    return { deliveryOrderId: input.deliveryOrderId, status };
  });
}
