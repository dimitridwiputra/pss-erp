import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { reserveStock } from '@pss/inventory';
import { requestSalesOrder } from '@pss/orders';
import { releaseFulfillment } from '@pss/fulfillment';
import { prepareInvoice } from '@pss/invoicing';
import { getOrCreateWalkInCustomer } from '@pss/master-data';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { parseOrThrow, RequestMetaShape } from './support/command-input';

const CheckoutPosSaleSchema = z.strictObject({ saleId: z.uuid(), ...RequestMetaShape });
export type CheckoutPosSaleInput = z.input<typeof CheckoutPosSaleSchema>;

export interface CheckedOutPosSale {
  id: string; status: 'PENDING_PAYMENT'; salesOrderId: string; deliveryOrderId: string; invoiceId: string; invoiceNumber: string; total: string;
}

interface SaleRow {
  organization_id: string; terminal_id: string; customer_id: string | null; status: string; version: number;
  shift_status: string; branch_id: string; warehouse_id: string;
}
interface LineRow { product_id: string; uom: string; qty: string; unit_price: string }

/**
 * POS-005: the checkout saga. Because this is one physical Postgres cluster
 * (compose.yaml — modular monolith, A-02), the whole chain runs as a single ACID
 * transaction shared across pos/inventory/orders/fulfillment/invoicing via each
 * domain's optional-`client` overload, instead of a multi-step compensating saga.
 * `RequestSalesOrder`'s idempotency key is `posSaleId` (DEC-108, POS-000.R03):
 * calling this twice for the same sale returns the same SalesOrder.
 */
export async function checkoutPosSale(pool: Pool, client: PoolClient | undefined, raw: CheckoutPosSaleInput): Promise<CheckedOutPosSale> {
  const input = parseOrThrow(CheckoutPosSaleSchema, raw);

  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const saleResult = await client.query<SaleRow>(
      `SELECT sale.organization_id, sale.terminal_id, sale.customer_id, sale.status, sale.version,
              s.status AS shift_status, t.branch_id, t.warehouse_id
       FROM pos.pos_sale sale JOIN pos.pos_shift s ON s.id = sale.shift_id JOIN pos.pos_terminal t ON t.id = sale.terminal_id
       WHERE sale.id = $1 FOR UPDATE OF sale`,
      [input.saleId],
    );
    const sale = saleResult.rows[0];
    if (!sale) throw new DomainError('NOT_FOUND');
    if (sale.status !== 'CART') throw new DomainError('INVALID_STATE_TRANSITION');
    if (sale.shift_status !== 'OPEN') throw new DomainError('POS_SHIFT_NOT_OPEN');

    const lines = await client.query<LineRow>(
      'SELECT product_id, uom, qty::text, unit_price::text FROM pos.pos_sale_line WHERE sale_id = $1 ORDER BY created_at', [input.saleId],
    );
    if (lines.rowCount === 0) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'lines', code: 'empty', message: 'Keranjang kosong.' }]);
    }

    // POS-004.AC01: no customer selected before Bayar defaults to the branch's walk-in customer.
    const customerId = sale.customer_id ?? (await getOrCreateWalkInCustomer(pool, { organizationId: sale.organization_id, branchId: sale.branch_id })).id;

    // POS-005.BR02: FULL reservation only. Any shortfall rolls back everything below —
    // nothing partially reserved, nothing else created — and the sale stays in CART.
    try {
      await reserveStock(pool, client, {
        organizationId: sale.organization_id, warehouseId: sale.warehouse_id,
        referenceType: 'POS_SALE', referenceId: input.saleId,
        lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty })),
        actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'INSUFFICIENT_STOCK') {
        throw new DomainError('POS_STOCK_INSUFFICIENT', [], error.fieldErrors);
      }
      throw error;
    }

    const order = await requestSalesOrder(pool, client, {
      organizationId: sale.organization_id,
      identityId: input.actor.userId ?? input.actor.serviceIdentity ?? 'pos',
      branchId: sale.branch_id, warehouseId: sale.warehouse_id, customerId,
      orderSource: 'WALK_IN', sourceApplication: 'PSS Kasir', handoverMode: 'CUSTOMER_PICKUP',
      clientKey: input.saleId,
      lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty, unitPrice: line.unit_price })),
      idempotencyKey: { key: input.saleId, requestHash: createHash('sha256').update(input.saleId).digest('hex') },
      actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    const fulfillment = await releaseFulfillment(pool, client, {
      organizationId: sale.organization_id, salesOrderId: order.salesOrderId, warehouseId: sale.warehouse_id,
      lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty })),
    });

    // `branchCode` should come from `organization` (not yet built) — derived here from the
    // branch UUID as a documented placeholder (see domains/pos/DOMAIN.md "Open decisions").
    const branchCode = sale.branch_id.replace(/-/g, '').slice(0, 6).toUpperCase();
    const invoice = await prepareInvoice(pool, client, {
      organizationId: sale.organization_id, branchCode, salesOrderId: order.salesOrderId,
      channel: 'POS', customerId, branchId: sale.branch_id,
      lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty, unitPrice: line.unit_price })),
      actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    await client.query(
      `UPDATE pos.pos_sale SET
         status = 'PENDING_PAYMENT', customer_id = $2, sales_order_id = $3, fulfillment_request_id = $4,
         delivery_order_id = $5, invoice_id = $6, invoice_number = $7, total = $8, checked_out_at = now(),
         version = version + 1, updated_at = now()
       WHERE id = $1`,
      [input.saleId, customerId, order.salesOrderId, fulfillment.fulfillmentRequestId, fulfillment.deliveryOrderId, invoice.invoiceId, invoice.number, invoice.total],
    );

    // POS_SALE_CHECKED_OUT has no registered payload schema; the owning domains' own events carry
    // the economic facts (MVP_PLAN §5), so pos publishes nothing here.
    await appendAuditEntry({
      organizationId: sale.organization_id, branchId: sale.branch_id, actor: input.actor,
      action: 'POS_SALE_CHECKED_OUT',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: sale.version + 1 },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: 'CART', after: 'PENDING_PAYMENT' },
        { path: 'salesOrderId', classification: 'INTERNAL', after: order.salesOrderId },
        { path: 'invoiceNumber', classification: 'INTERNAL', after: invoice.number },
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    return {
      id: input.saleId, status: 'PENDING_PAYMENT' as const, salesOrderId: order.salesOrderId,
      deliveryOrderId: fulfillment.deliveryOrderId, invoiceId: invoice.invoiceId, invoiceNumber: invoice.number, total: invoice.total,
    };
  });
}
