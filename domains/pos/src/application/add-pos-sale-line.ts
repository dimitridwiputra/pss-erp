import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { findProductByBarcode } from '@pss/master-data';
import { resolvePrice } from '@pss/commercial';
import { DomainError } from '@pss/contracts';
import { recomputeSaleTotals } from './pos-sale-cart';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const ByBarcodeSchema = z.strictObject({
  organizationId: z.uuid(), saleId: z.uuid(), priceListScope: z.string().min(1),
  barcode: z.string().min(1), qty: z.string().regex(/^\d+(\.\d{1,3})?$/).default('1'),
});
const ByProductSchema = z.strictObject({
  organizationId: z.uuid(), saleId: z.uuid(), priceListScope: z.string().min(1),
  productId: z.uuid(), uom: z.string().min(1), sku: z.string().min(1), name: z.string().min(1),
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/).default('1'),
});
const AddPosSaleLineSchema = z.union([ByBarcodeSchema, ByProductSchema]);
export type AddPosSaleLineInput = z.input<typeof AddPosSaleLineSchema>;

export interface AddedPosSaleLine {
  id: string; productId: string; sku: string; name: string; uom: string; qty: string; unitPrice: string; lineTotal: string;
}

/**
 * POS-003: resolves the product (scanned barcode via master-data, or a
 * productId+uom+sku+name already known to the caller from a katalog search
 * result — master-data exposes no "product by id" query, only by-barcode and
 * search-by-text) and its price (commercial), snapshots both onto the line
 * (POS-003.BR02), then recomputes the cart total server-side. The cart-time
 * stock indicator (POS-003.BR03, purely informational — reservation happens
 * at checkout) is not implemented in this slice: `domains/inventory` exposes
 * no read-only availability query yet, only mutating reserve/release/issue
 * commands.
 */
export async function addPosSaleLine(pool: Pool, raw: AddPosSaleLineInput): Promise<AddedPosSaleLine> {
  const input = parseOrThrow(AddPosSaleLineSchema, raw);
  const sale = await pool.query<{ status: string }>('SELECT status FROM pos.pos_sale WHERE id = $1', [input.saleId]);
  if (!sale.rows[0]) throw new DomainError('NOT_FOUND');
  if (sale.rows[0].status !== 'CART') throw new DomainError('INVALID_STATE_TRANSITION');

  let productId: string; let uom: string; let sku: string; let name: string;
  if ('barcode' in input) {
    const match = await findProductByBarcode(pool, { organizationId: input.organizationId, barcode: input.barcode });
    if (!match) throw new DomainError('NOT_FOUND');
    if (match.orderCapture !== 'PSS' || match.status !== 'ACTIVE') throw new DomainError('POS_SKU_NOT_SELLABLE');
    productId = match.productId; uom = match.uom; sku = match.sku; name = match.name;
  } else {
    productId = input.productId; uom = input.uom; sku = input.sku; name = input.name;
  }

  const price = await resolvePrice(pool, { organizationId: input.organizationId, productId, uom, priceListScope: input.priceListScope });

  const id = randomUUID();
  await pool.query(
    `INSERT INTO pos.pos_sale_line (id, sale_id, product_id, sku, name, uom, qty, unit_price, line_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $7::numeric * $8::numeric)`,
    [id, input.saleId, productId, sku, name, uom, input.qty, price.unitPrice],
  );
  await recomputeSaleTotals(pool, input.saleId);

  const inserted = await pool.query<{ line_total: string }>('SELECT line_total FROM pos.pos_sale_line WHERE id = $1', [id]);
  return { id, productId, sku, name, uom, qty: input.qty, unitPrice: price.unitPrice, lineTotal: inserted.rows[0]!.line_total };
}
