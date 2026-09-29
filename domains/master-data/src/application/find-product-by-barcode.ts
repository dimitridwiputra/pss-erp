import type { Pool } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const FindProductByBarcodeInputSchema = z.strictObject({
  organizationId: z.uuid(),
  barcode: z.string().min(1).max(64),
});

export type FindProductByBarcodeInput = z.input<typeof FindProductByBarcodeInputSchema>;

export interface ProductBarcodeMatch {
  productId: string;
  sku: string;
  name: string;
  uom: string;
  baseUom: string;
  conversionFactor: number;
  orderCapture: string;
  status: string;
}

interface ProductBarcodeRow {
  product_id: string;
  sku: string;
  name: string;
  uom: string;
  base_uom: string;
  conversion_factor: string;
  order_capture: string;
  status: string;
}

/**
 * Read model only (F1 scope): resolves a scanned barcode to its product and the UOM the barcode
 * itself represents, which is not necessarily the product's base UOM.
 */
export async function findProductByBarcode(pool: Pool, rawInput: FindProductByBarcodeInput): Promise<ProductBarcodeMatch | null> {
  const input = parseCommandInput(FindProductByBarcodeInputSchema, rawInput);
  const result = await pool.query<ProductBarcodeRow>(
    `SELECT p.id AS product_id, p.sku, p.name, pb.uom, p.base_uom, pu.conversion_factor, p.order_capture, p.status
     FROM core.product_barcode pb
     JOIN core.product p ON p.id = pb.product_id
     JOIN core.product_uom pu ON pu.product_id = p.id AND pu.uom = pb.uom
     WHERE p.organization_id = $1 AND pb.barcode = $2`,
    [input.organizationId, input.barcode],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    uom: row.uom,
    baseUom: row.base_uom,
    // conversion_factor is a quantity multiplier, not money; widening numeric(18,6) to number is safe here.
    conversionFactor: Number(row.conversion_factor),
    orderCapture: row.order_capture,
    status: row.status,
  };
}
