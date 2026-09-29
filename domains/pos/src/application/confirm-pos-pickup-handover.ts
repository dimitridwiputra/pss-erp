import type { Pool } from 'pg';
import { z } from 'zod';
import { confirmPickupHandover, getDeliveryOrderLines } from '@pss/fulfillment';
import { issueInvoice } from '@pss/invoicing';
import { issueInventory } from '@pss/inventory';
import { DomainError, BusinessDateSchema } from '@pss/contracts';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const ConfirmPosPickupHandoverSchema = z.strictObject({
  saleId: z.uuid(),
  actorId: z.uuid(),
  receiverName: z.string().min(1),
  mediaIds: z.array(z.string().min(1)).optional(),
  sodCashierNotHandoverEnabled: z.boolean().default(true),
  businessDate: BusinessDateSchema,
  actor: z.strictObject({ userId: z.uuid().optional(), roles: z.array(z.string()).default([]), serviceIdentity: z.string().optional() }),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});
export type ConfirmPosPickupHandoverInput = z.input<typeof ConfirmPosPickupHandoverSchema>;

export interface ConfirmedPosPickupHandover {
  saleId: string; status: 'HANDED_OVER'; invoiceNumber: string; invoiceTotal: string;
}

/**
 * POS-010 orchestration: full-delivery only in this slice (every line handed over exactly as
 * ordered — no partial-pickup UI yet; `getDeliveryOrderLines` is used only to learn each line's
 * product/UOM/qty for `ConfirmPickupHandover` and `IssueInvoice`, not to decide quantities).
 * `PosSale` moves to `HANDED_OVER` only after both the fulfillment and invoicing steps commit.
 */
export async function confirmPosPickupHandover(pool: Pool, raw: ConfirmPosPickupHandoverInput): Promise<ConfirmedPosPickupHandover> {
  const input = parseOrThrow(ConfirmPosPickupHandoverSchema, raw);

  const sale = await pool.query<{ delivery_order_id: string | null; invoice_id: string | null; status: string; organization_id: string; terminal_id: string }>(
    'SELECT delivery_order_id, invoice_id, status, organization_id, terminal_id FROM pos.pos_sale WHERE id = $1', [input.saleId],
  );
  const saleRow = sale.rows[0];
  if (!saleRow || !saleRow.delivery_order_id || !saleRow.invoice_id) throw new DomainError('NOT_FOUND');
  const terminal = await pool.query<{ warehouse_id: string }>('SELECT warehouse_id FROM pos.pos_terminal WHERE id = $1', [saleRow.terminal_id]);
  const warehouseId = terminal.rows[0]?.warehouse_id;
  if (!warehouseId) throw new DomainError('NOT_FOUND');

  const tender = await pool.query<{ accepted_by: string }>(
    "SELECT accepted_by FROM pos.pos_tender WHERE sale_id = $1 AND status = 'ACCEPTED' ORDER BY accepted_at LIMIT 1",
    [input.saleId],
  );

  const orderedLines = await getDeliveryOrderLines(pool, { deliveryOrderId: saleRow.delivery_order_id });
  if (orderedLines.length === 0) throw new DomainError('NOT_FOUND');

  await confirmPickupHandover(pool, {
    deliveryOrderId: saleRow.delivery_order_id,
    posSaleStatus: saleRow.status as 'PAID' | 'CREDIT_APPROVED' | 'PENDING_PAYMENT' | 'CART' | 'CANCELLED' | 'HANDED_OVER',
    actorId: input.actorId,
    tenderAcceptedBy: tender.rows[0]?.accepted_by,
    sodCashierNotHandoverEnabled: input.sodCashierNotHandoverEnabled,
    lines: orderedLines.map((line) => ({ deliveryOrderLineId: line.id, qtyHandedOver: line.qtyOrdered })),
    receiverName: input.receiverName,
    mediaIds: input.mediaIds,
  });

  // POS-010.R02: INVENTORY_ISSUED alongside DELIVERY_ORDER_DELIVERED. Consumes the same
  // reservation reserveStock created at checkout (referenceType 'POS_SALE', referenceId saleId).
  await issueInventory(pool, undefined, {
    organizationId: saleRow.organization_id, warehouseId,
    referenceType: 'POS_SALE', referenceId: input.saleId,
    lines: orderedLines.map((line) => ({ productId: line.productId, uom: line.uom, qty: line.qtyOrdered })),
  });

  const invoice = await issueInvoice(pool, {
    invoiceId: saleRow.invoice_id,
    deliveredLines: orderedLines.map((line) => ({ productId: line.productId, uom: line.uom, qtyDelivered: line.qtyOrdered })),
    invoiceDate: input.businessDate,
    actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
  });

  await pool.query("UPDATE pos.pos_sale SET status = 'HANDED_OVER', handed_over_at = now(), updated_at = now() WHERE id = $1", [input.saleId]);

  return { saleId: input.saleId, status: 'HANDED_OVER' as const, invoiceNumber: invoice.number, invoiceTotal: invoice.total };
}
