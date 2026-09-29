import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';

export const PosOfflineSaleLineSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/),
});

export const PosOfflineSaleSchema = z.strictObject({
  offlineSaleId: z.uuid(),
  number: z.string().min(1),
  customerId: z.uuid().nullable(),
  lines: z.array(PosOfflineSaleLineSchema).min(1),
  cashReceived: MoneyAmountSchema,
  deviceTime: z.iso.datetime(),
});
export type PosOfflineSale = z.infer<typeof PosOfflineSaleSchema>;

export const SyncPosOfflineBatchRequestSchema = z.strictObject({
  terminalId: z.uuid(),
  sales: z.array(PosOfflineSaleSchema).min(1).max(200),
});
export type SyncPosOfflineBatchRequest = z.infer<typeof SyncPosOfflineBatchRequestSchema>;

export const PosOfflineSaleResultSchema = z.strictObject({
  offlineSaleId: z.uuid(),
  outcome: z.enum(['SAVED', 'NEEDS_REVIEW']),
  posSaleId: z.uuid().nullable(),
  reason: z.string().nullable(),
});

export const SyncPosOfflineBatchResponseSchema = z.strictObject({
  batchId: z.uuid(),
  status: z.enum(['APPLIED', 'APPLIED_WITH_CONFLICTS']),
  results: z.array(PosOfflineSaleResultSchema),
});
export type SyncPosOfflineBatchResponse = z.infer<typeof SyncPosOfflineBatchResponseSchema>;
