import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';
import { PosSaleResponseSchema } from './pos-sale';
import { PosShiftStatusSchema } from './pos-shift';

/**
 * GET /kasir/shift-saya — the caller's current shift: the OPEN one, or else a closed one whose cash
 * is not yet handed over (so the screen can offer Serah Kas), plus any unfinished sale.
 */
export const KasirShiftSayaResponseSchema = z.strictObject({
  shift: z.strictObject({
    id: z.uuid(),
    terminalId: z.uuid(),
    terminalCode: z.string(),
    terminalName: z.string(),
    status: PosShiftStatusSchema,
    openingFloat: MoneyAmountSchema,
    expectedCash: MoneyAmountSchema.nullable(),
    countedCash: MoneyAmountSchema.nullable(),
    variance: MoneyAmountSchema.nullable(),
    cashSalesTotal: MoneyAmountSchema,
    paidSaleCount: z.int().nonnegative(),
    openedAt: z.iso.datetime(),
  }).nullable(),
  openSales: z.array(PosSaleResponseSchema),
});
export type KasirShiftSayaResponse = z.infer<typeof KasirShiftSayaResponseSchema>;

/** GET /kasir/scan/{barcode} */
export const KasirScanResponseSchema = z.strictObject({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  uom: z.string(),
  unitPrice: MoneyAmountSchema,
  qtyAvailable: z.string().nullable(),
});
export type KasirScanResponse = z.infer<typeof KasirScanResponseSchema>;

/** GET /kasir/products?q= — katalog search by SKU or name. */
export const KasirKatalogItemSchema = z.strictObject({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']),
});
export const KasirKatalogResponseSchema = z.strictObject({ items: z.array(KasirKatalogItemSchema) });
export type KasirKatalogResponse = z.infer<typeof KasirKatalogResponseSchema>;

/** GET /kasir/products/{productId}/units — the units a katalog pick can add, each with its counter price. */
export const KasirProductUnitsResponseSchema = z.strictObject({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  units: z.array(z.strictObject({ uom: z.string(), unitPrice: MoneyAmountSchema })),
});
export type KasirProductUnitsResponse = z.infer<typeof KasirProductUnitsResponseSchema>;
