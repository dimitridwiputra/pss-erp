import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { findProductByBarcode } from '@pss/master-data';
import { resolvePrice } from '@pss/commercial';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { lockCart, recomputeSaleTotals } from './pos-sale-cart';
import { parseOrThrow, QuantityInputSchema, RequestMetaShape } from './support/command-input';

const AddPosSaleLineSchema = z.strictObject({
  saleId: z.uuid(), priceListScope: z.string().min(1),
  barcode: z.string().min(1).max(64), qty: QuantityInputSchema.default('1'),
  ...RequestMetaShape,
});
export type AddPosSaleLineInput = z.input<typeof AddPosSaleLineSchema>;

export interface AddedPosSaleLine {
  id: string; productId: string; sku: string; name: string; uom: string; qty: string; unitPrice: string; lineTotal: string; saleTotal: string;
}

/**
 * POS-003: resolves the product from the scanned barcode (master-data) and its price
 * (commercial), snapshots both onto the line (POS-003.BR02), then recomputes the cart total
 * server-side. The product identity is never taken from the caller: an earlier variant accepted
 * `productId`/`sku`/`name` from a katalog pick, which let a client put any name on a line.
 * A katalog pick waits for a master-data "product by id" query (MVP_PLAN §10, MVP-OD-27).
 *
 * The cart-time stock indicator (POS-003.BR03, informational only; reservation happens at
 * checkout) is not implemented: `domains/inventory` exposes no read-only availability query.
 */
export async function addPosSaleLine(pool: Pool, client: PoolClient | undefined, raw: AddPosSaleLineInput): Promise<AddedPosSaleLine> {
  const input = parseOrThrow(AddPosSaleLineSchema, raw);
  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const cart = await lockCart(client, input.saleId);

    const match = await findProductByBarcode(pool, { organizationId: cart.organizationId, barcode: input.barcode });
    if (!match) throw new DomainError('NOT_FOUND');
    if (match.orderCapture !== 'PSS' || match.status !== 'ACTIVE') throw new DomainError('POS_SKU_NOT_SELLABLE');

    const price = await resolvePrice(pool, {
      organizationId: cart.organizationId, productId: match.productId, uom: match.uom, priceListScope: input.priceListScope,
    });

    // A repeat scan of the same product, unit and price raises that line's quantity: one line per
    // product keeps checkout's reservation (one per sale and product) and the invoice lines intact.
    const merged = await client.query<{ id: string; qty: string; unit_price: string; line_total: string }>(
      `UPDATE pos.pos_sale_line SET qty = qty + $5::numeric, line_total = (qty + $5::numeric) * unit_price
       WHERE sale_id = $1 AND product_id = $2 AND uom = $3 AND unit_price = $4::numeric
       RETURNING id, qty::text, unit_price::text, line_total::text`,
      [input.saleId, match.productId, match.uom, price.unitPrice, input.qty],
    );
    const id = merged.rows[0]?.id ?? randomUUID();
    const inserted = merged.rows[0] ? merged : await client.query<{ id: string; qty: string; unit_price: string; line_total: string }>(
      `INSERT INTO pos.pos_sale_line (id, sale_id, product_id, sku, name, uom, qty, unit_price, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $7::numeric * $8::numeric)
       RETURNING id, qty::text, unit_price::text, line_total::text`,
      [id, input.saleId, match.productId, match.sku, match.name, match.uom, input.qty, price.unitPrice],
    );
    const line = inserted.rows[0]!;
    const totals = await recomputeSaleTotals(client, input.saleId);
    await appendAuditEntry({
      organizationId: cart.organizationId, branchId: cart.branchId, actor: input.actor, action: 'POS_SALE_LINE_ADDED',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: totals.version },
      changes: [
        { path: `lines.${id}.productId`, classification: 'INTERNAL', after: match.productId },
        { path: `lines.${id}.qty`, classification: 'INTERNAL', after: line.qty },
        { path: `lines.${id}.unitPrice`, classification: 'INTERNAL', after: line.unit_price },
        { path: 'total', classification: 'INTERNAL', after: totals.total },
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
    return {
      id, productId: match.productId, sku: match.sku, name: match.name, uom: match.uom,
      qty: line.qty, unitPrice: line.unit_price, lineTotal: line.line_total, saleTotal: totals.total,
    };
  });
}
