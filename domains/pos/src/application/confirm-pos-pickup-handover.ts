import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { confirmPickupHandover, getDeliveryOrderLines } from '@pss/fulfillment';
import { issueInvoice } from '@pss/invoicing';
import { issueInventory } from '@pss/inventory';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { jakartaBusinessDate, parseOrThrow, RequestMetaShape } from './support/command-input';

const ConfirmPosPickupHandoverSchema = z.strictObject({
  saleId: z.uuid(),
  actorId: z.uuid(),
  receiverName: z.string().trim().min(1).max(120),
  // POS-010.R03 / SOD-09: the policy flag `pos.sod.cashier_not_handover`. No configured value is
  // read yet, so it defaults on, which fails closed.
  sodCashierNotHandoverEnabled: z.boolean().default(true),
  ...RequestMetaShape,
});
export type ConfirmPosPickupHandoverInput = z.input<typeof ConfirmPosPickupHandoverSchema>;

export interface ConfirmedPosPickupHandover {
  saleId: string; status: 'HANDED_OVER'; invoiceNumber: string; invoiceTotal: string;
}

/**
 * POS-010 orchestration, full delivery only (no partial-pickup UI yet). One transaction covers
 * the delivery (fulfillment, DELIVERY_ORDER_DELIVERED), the stock issue (inventory,
 * INVENTORY_ISSUED), the invoice issue (invoicing, INVOICE_ISSUED) and the sale's HANDED_OVER
 * state (POS-010.R02). Each of these used to commit on its own, so a failure after the first left
 * goods delivered with stock unissued or an invoice never issued.
 *
 * POS-010.BR03: the invoice's business date is the handover date.
 */
export async function confirmPosPickupHandover(pool: Pool, client: PoolClient | undefined, raw: ConfirmPosPickupHandoverInput): Promise<ConfirmedPosPickupHandover> {
  const input = parseOrThrow(ConfirmPosPickupHandoverSchema, raw);
  const businessDate = jakartaBusinessDate();

  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const sale = await client.query<{
      delivery_order_id: string | null; invoice_id: string | null; status: string; organization_id: string;
      version: number; warehouse_id: string; branch_id: string;
    }>(
      `SELECT sale.delivery_order_id, sale.invoice_id, sale.status, sale.organization_id, sale.version, t.warehouse_id, t.branch_id
       FROM pos.pos_sale sale JOIN pos.pos_terminal t ON t.id = sale.terminal_id WHERE sale.id = $1 FOR UPDATE OF sale`,
      [input.saleId],
    );
    const saleRow = sale.rows[0];
    if (!saleRow) throw new DomainError('NOT_FOUND');
    if (saleRow.status === 'HANDED_OVER') throw new DomainError('POS_ALREADY_HANDED_OVER');
    if (!saleRow.delivery_order_id || !saleRow.invoice_id) throw new DomainError('POS_NOT_PAID');

    const tender = await client.query<{ accepted_by: string }>(
      "SELECT accepted_by FROM pos.pos_tender WHERE sale_id = $1 AND status = 'ACCEPTED' ORDER BY accepted_at LIMIT 1",
      [input.saleId],
    );

    const orderedLines = await getDeliveryOrderLines(pool, { deliveryOrderId: saleRow.delivery_order_id }, client);
    if (orderedLines.length === 0) throw new DomainError('NOT_FOUND');

    await confirmPickupHandover(pool, client, {
      deliveryOrderId: saleRow.delivery_order_id,
      posSaleStatus: saleRow.status as 'PAID' | 'CREDIT_APPROVED' | 'PENDING_PAYMENT' | 'CART' | 'CANCELLED' | 'HANDED_OVER',
      actorId: input.actorId,
      tenderAcceptedBy: tender.rows[0]?.accepted_by,
      sodCashierNotHandoverEnabled: input.sodCashierNotHandoverEnabled,
      lines: orderedLines.map((line) => ({ deliveryOrderLineId: line.id, qtyHandedOver: line.qtyOrdered })),
      receiverName: input.receiverName,
      requestId: input.requestId, correlationId: input.correlationId,
    });

    // Consumes the reservation reserveStock created at checkout (referenceType 'POS_SALE').
    await issueInventory(pool, client, {
      organizationId: saleRow.organization_id, warehouseId: saleRow.warehouse_id,
      referenceType: 'POS_SALE', referenceId: input.saleId,
      lines: orderedLines.map((line) => ({ productId: line.productId, uom: line.uom, qty: line.qtyOrdered })),
      actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    const invoice = await issueInvoice(pool, client, {
      invoiceId: saleRow.invoice_id,
      deliveredLines: orderedLines.map((line) => ({ productId: line.productId, uom: line.uom, qtyDelivered: line.qtyOrdered })),
      invoiceDate: businessDate,
      actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    await client.query(
      "UPDATE pos.pos_sale SET status = 'HANDED_OVER', handed_over_at = now(), version = version + 1, updated_at = now() WHERE id = $1",
      [input.saleId],
    );
    await appendAuditEntry({
      organizationId: saleRow.organization_id, branchId: saleRow.branch_id, actor: input.actor, action: 'POS_SALE_HANDED_OVER',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: saleRow.version + 1 },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: saleRow.status, after: 'HANDED_OVER' },
        { path: 'receiverName', classification: 'PERSONAL', after: input.receiverName },
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    return { saleId: input.saleId, status: 'HANDED_OVER' as const, invoiceNumber: invoice.number, invoiceTotal: invoice.total };
  });
}
