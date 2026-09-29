import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';
import { PosSaleResponseSchema } from './pos-sale';
import { PosShiftResponseSchema } from './pos-shift';

/** GET /kasir/shift-saya */
export const KasirShiftSayaResponseSchema = z.strictObject({
  shift: PosShiftResponseSchema.nullable(),
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

/** GET /kasir/katalog?q= */
export const KasirKatalogItemSchema = z.strictObject({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']),
});
export const KasirKatalogResponseSchema = z.strictObject({ items: z.array(KasirKatalogItemSchema) });
export type KasirKatalogResponse = z.infer<typeof KasirKatalogResponseSchema>;
