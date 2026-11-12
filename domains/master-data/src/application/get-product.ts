import type { Pool, PoolClient } from 'pg';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const GetProductInputSchema = z.strictObject({
  organizationId: z.uuid(),
  productId: z.uuid(),
});

export type GetProductInput = z.input<typeof GetProductInputSchema>;

export interface ProductUnit {
  uom: string;
  /** How many base units one of this unit holds, as the database's decimal string. */
  conversionFactor: string;
  isBase: boolean;
  /** The label scanned for this unit, when the product has one. At most one barcode per unit. */
  barcode: string | null;
}

export interface ProductDetail {
  productId: string;
  sku: string;
  name: string;
  baseUom: string;
  orderCapture: 'PSS' | 'EXTERNAL';
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  taxCode: 'VAT_OUTPUT' | 'EXEMPT' | 'NON_VAT' | null;
  version: number;
  units: ProductUnit[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The shape MVP-OD-27 asks POS for: the same product read, projected to what a katalog pick needs and
 * nothing else. It is a projection of the one query below rather than a second query, so the two
 * cannot disagree about which units a product sells.
 */
export interface ProductSaleUnits {
  productId: string;
  sku: string;
  name: string;
  status: string;
  orderCapture: string;
  units: { uom: string; barcode: string | null }[];
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  base_uom: string;
  order_capture: 'PSS' | 'EXTERNAL';
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  tax_code: ProductDetail['taxCode'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface UnitRow {
  product_id: string;
  uom: string;
  conversion_factor: string;
  is_base: boolean;
  barcode: string | null;
}

async function readProduct(
  runner: Pool | PoolClient,
  organizationId: string,
  productId: string,
): Promise<{ product: ProductRow; units: UnitRow[] } | null> {
  const product = await runner.query<ProductRow>(
    `SELECT id, sku, name, base_uom, order_capture, status, tax_code, version, created_at, updated_at
     FROM core.product WHERE id = $1 AND organization_id = $2`,
    [productId, organizationId],
  );
  const row = product.rows[0];
  if (!row) return null;
  const units = await runner.query<UnitRow>(
    `SELECT u.product_id, u.uom, u.conversion_factor, u.is_base,
            (SELECT b.barcode FROM core.product_barcode b
              WHERE b.product_id = u.product_id AND b.uom = u.uom
              ORDER BY b.created_at LIMIT 1) AS barcode
     FROM core.product_uom u
     WHERE u.product_id = $1
     ORDER BY u.is_base DESC, u.uom`,
    [productId],
  );
  return { product: row, units: units.rows };
}

function toDetail(read: { product: ProductRow; units: UnitRow[] }): ProductDetail {
  return {
    productId: read.product.id,
    sku: read.product.sku,
    name: read.product.name,
    baseUom: read.product.base_uom,
    orderCapture: read.product.order_capture,
    status: read.product.status,
    taxCode: read.product.tax_code,
    version: read.product.version,
    createdAt: read.product.created_at.toISOString(),
    updatedAt: read.product.updated_at.toISOString(),
    units: read.units.map((unit) => ({
      uom: unit.uom,
      conversionFactor: unit.conversion_factor,
      isBase: unit.is_base,
      barcode: unit.barcode,
    })),
  };
}

/**
 * One product with its units and their barcodes — what the Barang screen edits, and what a caller
 * needs before it can price or receive the product. Read-only, so no audit entry (AGENTS.md §14
 * covers mutations).
 *
 * A product in another organization is `NOT_FOUND` rather than an empty result: an id this caller
 * cannot see should not be distinguishable from one that does not exist. The `organization_id` filter
 * is the whole ownership check — which is why the answer carries no `organizationId` of its own,
 * since every caller already knows the organization it asked about.
 */
export async function getProduct(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: GetProductInput,
): Promise<ProductDetail> {
  const input = parseCommandInput(GetProductInputSchema, rawInput);
  const read = await readProduct(client ?? pool, input.organizationId, input.productId);
  if (!read) throw new DomainError('NOT_FOUND');
  return toDetail(read);
}

/**
 * MVP-OD-27, requested by the POS stream so the katalog can offer a product's sellable units and
 * their barcodes instead of a name typed by the cashier. The caller applies its own sellability
 * rules (`PosService.scan` requires `orderCapture === 'PSS'` and `status === 'ACTIVE'`); this read
 * reports what the product actually has, because master data is the only owner of that fact.
 *
 * **Two arguments, not three.** `getProduct` above takes `(pool, client, input)` because the API
 * reads the product back inside a command's transaction; this one never does, and the POS stream
 * asked for `getProductSaleUnits(pool, { organizationId, productId })`. A three-argument shape here
 * would silently take a body where a client is expected, so the difference is deliberate and is the
 * one place in this domain where a read is not transaction-aware.
 */
export async function getProductSaleUnits(pool: Pool, rawInput: GetProductInput): Promise<ProductSaleUnits> {
  const input = parseCommandInput(GetProductInputSchema, rawInput);
  const read = await readProduct(pool, input.organizationId, input.productId);
  if (!read) throw new DomainError('NOT_FOUND');
  return {
    productId: read.product.id,
    sku: read.product.sku,
    name: read.product.name,
    status: read.product.status,
    orderCapture: read.product.order_capture,
    units: read.units.map((unit) => ({ uom: unit.uom, barcode: unit.barcode })),
  };
}
