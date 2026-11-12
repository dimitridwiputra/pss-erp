import { z } from 'zod';
import { BusinessDateSchema, MoneyAmountSchema } from '../primitives';
import { PosSaleStatusSchema } from './pos-sale';
import { PosReceiptResponseSchema } from './pos-receipt';
import { PosSaleResponseSchema } from './pos-sale';

/**
 * Back-office reads over counter sales (/kantor/penjualan, the /kantor dashboard). Guarded by
 * `pos.report.view` at the sale's warehouse (POS-015); the invoice copy by `invoicing.invoice.print`.
 */

/** GET /pos/reports/sales — filters are an allow-list; dates are Asia/Jakarta business dates. */
export const PosSalesListQuerySchema = z.strictObject({
  from: BusinessDateSchema,
  to: BusinessDateSchema,
  shiftId: z.uuid().optional(),
  cashierUserId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).refine((query) => query.from <= query.to, { path: ['to'], message: 'Tanggal akhir tidak boleh sebelum tanggal awal.' });
export type PosSalesListQuery = z.infer<typeof PosSalesListQuerySchema>;

export const PosSalesListItemSchema = z.strictObject({
  saleId: z.uuid(),
  invoiceNumber: z.string(),
  status: PosSaleStatusSchema,
  total: MoneyAmountSchema,
  checkedOutAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  handedOverAt: z.iso.datetime().nullable(),
  shiftId: z.uuid(),
  cashierUserId: z.uuid(),
  cashierName: z.string().nullable(),
  terminalCode: z.string(),
  terminalName: z.string(),
});
export const PosSalesListResponseSchema = z.strictObject({
  items: z.array(PosSalesListItemSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
});
export type PosSalesListResponse = z.infer<typeof PosSalesListResponseSchema>;

/** GET /pos/reports/sales/{id} */
export const PosSalesReportDetailSchema = z.strictObject({
  sale: PosSaleResponseSchema,
  terminalName: z.string(),
  cashierName: z.string().nullable(),
  checkedOutAt: z.iso.datetime(),
  handedOverAt: z.iso.datetime().nullable(),
});
export type PosSalesReportDetail = z.infer<typeof PosSalesReportDetailSchema>;

/** POST /pos/reports/sales/{id}/copies — an invoice copy from the back office, always "SALINAN", with a reason. */
export const PrintPosInvoiceCopyRequestSchema = z.strictObject({ reason: z.string().trim().min(1).max(200) });
export type PrintPosInvoiceCopyRequest = z.infer<typeof PrintPosInvoiceCopyRequestSchema>;
export const PosInvoiceCopyResponseSchema = PosReceiptResponseSchema;

/**
 * GET /pos/reports/summary?date= — the dashboard tiles. `salesTotal`/`saleCount` count sales paid on
 * that business date; `undepositedCash` is counter cash Finance has not yet counted (any date).
 */
export const PosDashboardSummaryQuerySchema = z.strictObject({ date: BusinessDateSchema });
export const PosDashboardSummaryResponseSchema = z.strictObject({
  businessDate: BusinessDateSchema,
  salesTotal: MoneyAmountSchema,
  saleCount: z.int().nonnegative(),
  undepositedCash: MoneyAmountSchema,
  undepositedPaymentCount: z.int().nonnegative(),
});
export type PosDashboardSummaryResponse = z.infer<typeof PosDashboardSummaryResponseSchema>;

/**
 * GET /pos/reports/sales-trend?to=&days= — paid counter sales per business date for the dashboard
 * chart, every date in the window present (zero when nothing sold). Same scope as the summary.
 */
export const PosSalesTrendQuerySchema = z.strictObject({
  to: BusinessDateSchema,
  days: z.coerce.number().int().min(1).max(31).default(7),
});
export const PosSalesTrendResponseSchema = z.strictObject({
  points: z.array(z.strictObject({ businessDate: BusinessDateSchema, salesTotal: MoneyAmountSchema, saleCount: z.int().nonnegative() })),
});
export type PosSalesTrendResponse = z.infer<typeof PosSalesTrendResponseSchema>;
