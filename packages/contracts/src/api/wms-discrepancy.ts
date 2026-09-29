import { z } from 'zod';
import { DecimalStringSchema } from '../primitives';

export const StockDiscrepancyReportTypeSchema = z.enum(['DAMAGED', 'MISSING', 'EXCESS', 'WRONG_LOCATION']);

/** POST /gudang/masalah — WMS-011 "Laporkan Masalah". */
export const ReportStockDiscrepancyRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  locationCode: z.string().min(1),
  productId: z.uuid(),
  uom: z.string().min(1),
  reportType: StockDiscrepancyReportTypeSchema,
  qty: DecimalStringSchema,
  reasonCode: z.string().min(1),
  evidenceMediaIds: z.array(z.string().min(1)).default([]),
});
export type ReportStockDiscrepancyRequest = z.infer<typeof ReportStockDiscrepancyRequestSchema>;

export const StockDiscrepancyReportResponseSchema = z.strictObject({ id: z.uuid() });
export type StockDiscrepancyReportResponse = z.infer<typeof StockDiscrepancyReportResponseSchema>;

/** POST /wms/discrepancies/{id}/resolve — supervisor decision on a reported exception. */
export const ResolveStockDiscrepancyRequestSchema = z.strictObject({
  decision: z.enum(['ADJUST', 'REJECT']),
});
export type ResolveStockDiscrepancyRequest = z.infer<typeof ResolveStockDiscrepancyRequestSchema>;

export const ResolveStockDiscrepancyResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['REPORTED', 'ADJUSTED', 'REJECTED']),
});
export type ResolveStockDiscrepancyResponse = z.infer<typeof ResolveStockDiscrepancyResponseSchema>;
