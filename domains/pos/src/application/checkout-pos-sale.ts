import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withAuditedTransaction } from '@pss/audit';
import { reserveStock } from '@pss/inventory';
import { requestSalesOrder } from '@pss/orders';
import { releaseFulfillment } from '@pss/fulfillment';
import { prepareInvoice } from '@pss/invoicing';
import { getOrCreateWalkInCustomer } from '@pss/master-data';
import { DomainError } from '@pss/contracts';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const CheckoutPosSaleSchema = z.strictObject({
  saleId: z.uuid(),
  actor: z.strictObject({ userId: z.uuid(), roles: z.array(z.string()).default([]) }),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});
export type CheckoutPosSaleInput = z.input<typeof CheckoutPosSaleSchema>;

export interface CheckedOutPosSale {
  id: string; status: 'PENDING_PAYMENT'; salesOrderId: string; deliveryOrderId: string; invoiceNumber: string; total: string;
}

interface SaleRow { organization_id: string; terminal_id: string; customer_id: string | null; status: string }
interface TerminalRow { organization_id: string; branch_id: string; warehouse_id: string }
interface LineRow { product_id: string; uom: string; qty: string; unit_price: string }

/**
 * POS-005: the checkout saga. Because this is one physical Postgres cluster
 * (compose.yaml — modular monolith, A-02), the whole chain runs as a single ACID
 * transaction shared across pos/inventory/orders/fulfillment/invoicing via each
 * domain's optional-`client` overload, instead of a multi-step compensating saga.
 * `RequestSalesOrder`'s idempotency key is `posSaleId` (DEC-108, POS-000.R03):
 * calling this twice for the same sale returns the same SalesOrder.
 */
export async function checkoutPosSale(pool: Pool, raw: CheckoutPosSaleInput): Promise<CheckedOutPosSale> {
  const input = parseOrThrow(CheckoutPosSaleSchema, raw);

  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const saleResult = await client.query<SaleRow>(
      'SELECT organization_id, terminal_id, customer_id, status FROM pos.pos_sale WHERE id = $1 FOR UPDATE',
      [input.saleId],
    );
    const sale = saleResult.rows[0];
    if (!sale) throw new DomainError('NOT_FOUND');
    if (sale.status !== 'CART') throw new DomainError('INVALID_STATE_TRANSITION');

    const lines = await client.query<LineRow>(
      'SELECT product_id, uom, qty, unit_price FROM pos.pos_sale_line WHERE sale_id = $1', [input.saleId],
    );
    if (lines.rowCount === 0) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'lines', code: 'empty', message: 'Keranjang kosong.' }]);
    }

    const terminal = await client.query<TerminalRow>(
      'SELECT organization_id, branch_id, warehouse_id FROM pos.pos_terminal WHERE id = $1', [sale.terminal_id],
    );
    const t = terminal.rows[0];
    if (!t) throw new DomainError('NOT_FOUND');

    // POS-004.AC01: no customer selected before Bayar defaults to the branch's walk-in customer.
    const customerId = sale.customer_id ?? (await getOrCreateWalkInCustomer(pool, { organizationId: t.organization_id, branchId: t.branch_id })).id;

    // POS-005.BR02: FULL reservation only. Any shortfall rolls back everything below —
    // nothing partially reserved, nothing else created — and the sale stays in CART.
    await reserveStock(pool, client, {
      organizationId: t.organization_id, warehouseId: t.warehouse_id,
      referenceType: 'POS_SALE', referenceId: input.saleId,
      lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty })),
      actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    const order = await requestSalesOrder(pool, client, {
      organizationId: t.organization_id,
      identityId: input.actor.userId,
      branchId: t.branch_id, warehouseId: t.warehouse_id, customerId,
      orderSource: 'WALK_IN', sourceApplication: 'PSS Kasir', handoverMode: 'CUSTOMER_PICKUP',
      clientKey: input.saleId,
      lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty, unitPrice: line.unit_price })),
      idempotencyKey: { key: input.saleId, requestHash: createHash('sha256').update(input.saleId).digest('hex') },
      actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    const fulfillment = await releaseFulfillment(pool, client, {
      organizationId: t.organization_id, salesOrderId: order.salesOrderId, warehouseId: t.warehouse_id,
      lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty })),
    });

    // `branchCode` should come from `organization` (not yet built) — derived here from the
    // branch UUID as a documented placeholder (see domains/pos/DOMAIN.md "Open decisions").
    const branchCode = t.branch_id.replace(/-/g, '').slice(0, 6).toUpperCase();
    // The customer is named so `invoicing` can resolve the line tax codes (TAX-002). Without it the
    // invoice has no tax treatment and preparation is refused rather than issued at no tax, which
    // is POS-005.E2's intended behaviour when tax is not configured.
    const invoice = await prepareInvoice(pool, client, {
      organizationId: t.organization_id, branchCode, salesOrderId: order.salesOrderId, customerId,
      lines: lines.rows.map((line) => ({ productId: line.product_id, uom: line.uom, qty: line.qty, unitPrice: line.unit_price })),
      actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    await client.query(
      `UPDATE pos.pos_sale SET
         status = 'PENDING_PAYMENT', customer_id = $2, sales_order_id = $3, fulfillment_request_id = $4,
         delivery_order_id = $5, invoice_id = $6, invoice_number = $7, total = $8, checked_out_at = now(), updated_at = now()
       WHERE id = $1`,
      [input.saleId, customerId, order.salesOrderId, fulfillment.fulfillmentRequestId, fulfillment.deliveryOrderId, invoice.invoiceId, invoice.number, invoice.total],
    );

    // POS_SALE_CHECKED_OUT publication deferred: no registered payload schema yet (same gap
    // pattern as CUSTOMER_CREATED/FULFILLMENT_RELEASED in the sibling domains built this session).
    await appendAuditEntry({
      organizationId: t.organization_id, branchId: t.branch_id, actor: input.actor,
      action: 'POS_SALE_CHECKED_OUT',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: 2 },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: 'CART', after: 'PENDING_PAYMENT' },
        { path: 'salesOrderId', classification: 'INTERNAL', after: order.salesOrderId },
        { path: 'invoiceNumber', classification: 'INTERNAL', after: invoice.number },
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    return {
      id: input.saleId, status: 'PENDING_PAYMENT' as const, salesOrderId: order.salesOrderId,
      deliveryOrderId: fulfillment.deliveryOrderId, invoiceNumber: invoice.number, total: invoice.total,
    };
  });
}
