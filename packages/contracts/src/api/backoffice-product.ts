import { z } from 'zod';

/**
 * Barang — the back office's product master (MDM-001..003).
 *
 * Writes are gated on `master_data.product.manage` (MVP_PLAN §7, `admin.demo` as MASTER_DATA_STEWARD);
 * reads use the same permission because no separate read permission is registered (MVP-OD-20). A
 * `sku` is the product's identity and is not editable, so no endpoint offers it.
 *
 * Money is never in this file. A price belongs to `commercial` and a cost to `inventory`; a product
 * carries neither, which is why creating one and pricing it are separate steps.
 */

/** `core.product.status`. Raw enum values never reach the UI — the Barang screen maps them to labels. */
export const ProductStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']);
/**
 * A product's default sales tax code (TAX-001). `VAT_OUTPUT` = the product carries PPN when the
 * customer is charged PPN; `NON_VAT` / `EXEMPT` = never. `null` on a read is "not set", which a PPN
 * sale refuses rather than treating as tax-free.
 */
export const ProductTaxCodeSchema = z.enum(['VAT_OUTPUT', 'EXEMPT', 'NON_VAT']);

/** A conversion factor is `numeric(18,6)` on `core.product_uom`. */
const Decimal6Schema = z.string().regex(/^\d+(\.\d{1,6})?$/, 'Isi angka dengan maksimal 6 desimal.');

/** GET /master-data/products — the Barang list, filtered and sorted by allow-listed fields only. */
export const ProductListQuerySchema = z.strictObject({
  /** Matches SKU or name; wildcards typed by the operator are escaped, not honoured. */
  q: z.string().trim().min(1).max(100).optional(),
  status: ProductStatusSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'sku', 'createdAt']).default('name'),
});
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;

export const ProductListItemSchema = z.strictObject({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  baseUom: z.string(),
  status: ProductStatusSchema,
  /** How many units this product sells, so the list can show "PCS, KARTON" without a second call. */
  unitCount: z.int().nonnegative(),
  hasBarcode: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const ProductListResponseSchema = z.strictObject({
  items: z.array(ProductListItemSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  hasMore: z.boolean(),
});
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;

/** POST /master-data/products — MDM-001. Status defaults to DRAFT so nothing is sellable before it is priced. */
export const CreateProductRequestSchema = z.strictObject({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  baseUom: z.string().trim().min(1).max(16),
  /** Leave it out for a PSS-captured product; set EXTERNAL only for a product ordered in another system. */
  orderCapture: z.enum(['PSS', 'EXTERNAL']).optional(),
  status: ProductStatusSchema.optional(),
  taxCode: ProductTaxCodeSchema.optional(),
});
export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

export const ProductUnitSchema = z.strictObject({
  uom: z.string(),
  conversionFactor: z.string(),
  isBase: z.boolean(),
  /** At most one barcode per unit; a unit with no label has null. */
  barcode: z.string().nullable(),
});
export const ProductDetailSchema = z.strictObject({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  baseUom: z.string(),
  orderCapture: z.enum(['PSS', 'EXTERNAL']),
  status: ProductStatusSchema,
  taxCode: ProductTaxCodeSchema.nullable(),
  version: z.int().positive(),
  units: z.array(ProductUnitSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;

export const UpdateProductRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  status: ProductStatusSchema.optional(),
  baseUom: z.string().trim().min(1).max(16).optional(),
  orderCapture: z.enum(['PSS', 'EXTERNAL']).optional(),
  taxCode: ProductTaxCodeSchema.optional(),
  /** The version the screen loaded. A mismatch is STALE_DATA rather than a silent overwrite. */
  expectedVersion: z.int().positive().optional(),
}).refine(
  (request) => Object.keys(request).some((key) => key !== 'expectedVersion' && request[key as keyof typeof request] !== undefined),
  { message: 'Isi minimal satu kolom yang akan diubah.', path: ['name'] },
);
export type UpdateProductRequest = z.infer<typeof UpdateProductRequestSchema>;

export const UpdateProductResponseSchema = z.strictObject({ productId: z.uuid(), version: z.int().positive() });

/** POST /master-data/products/{id}/barcodes — MDM-003. A duplicate is DUPLICATE_CODE on the barcode field. */
export const AddProductBarcodeRequestSchema = z.strictObject({
  /** Which unit the label represents: a case barcode is not a piece barcode. */
  uom: z.string().trim().min(1).max(16),
  /** Letters, digits, dot, dash, underscore. No symbology or check digit is verified (AGENTS.md §6). */
  barcode: z.string().trim().min(6).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Barcode hanya berisi huruf, angka, titik, strip, atau garis bawah.'),
});
export type AddProductBarcodeRequest = z.infer<typeof AddProductBarcodeRequestSchema>;

export const ProductBarcodeResponseSchema = z.strictObject({
  barcodeId: z.uuid(), productId: z.uuid(), barcode: z.string(), uom: z.string(),
});
export type ProductBarcodeResponse = z.infer<typeof ProductBarcodeResponseSchema>;

/** POST /master-data/products/{id}/uoms — MDM-003. The factor is written once and never edited (UOM_FACTOR_LOCKED). */
export const AddProductUomRequestSchema = z.strictObject({
  uom: z.string().trim().min(1).max(16),
  conversionFactor: Decimal6Schema,
});
export type AddProductUomRequest = z.infer<typeof AddProductUomRequestSchema>;

export const ProductUomResponseSchema = z.strictObject({
  uomId: z.uuid(), productId: z.uuid(), uom: z.string(), conversionFactor: z.string(),
});
export type ProductUomResponse = z.infer<typeof ProductUomResponseSchema>;
