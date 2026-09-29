import { z } from 'zod';
import { DecimalStringSchema } from '../primitives';

export const WarehouseTaskTypeSchema = z.enum(['RECEIVE', 'PUTAWAY', 'PICK', 'COUNT', 'PACK', 'STAGE', 'LOAD']);
export const WarehouseTaskStatusSchema = z.enum(['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_SHORT', 'CANCELLED']);

/** POST /gudang/terima — WMS-003 (no-PO simplification). */
export const ReceiveGoodsLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qty: DecimalStringSchema });
export const ReceiveGoodsRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  locationCode: z.string().min(1),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(ReceiveGoodsLineSchema).min(1),
});
export type ReceiveGoodsRequest = z.infer<typeof ReceiveGoodsRequestSchema>;

export const ReceiveGoodsResponseSchema = z.strictObject({
  receiveTaskIds: z.array(z.uuid()),
  putawayTaskIds: z.array(z.uuid()),
});
export type ReceiveGoodsResponse = z.infer<typeof ReceiveGoodsResponseSchema>;

/**
 * POST /wms/allocations — WMS-005 (simplified). Exposed as a directly-callable system endpoint
 * until a real `FULFILLMENT_RELEASED` consumer triggers it automatically (see `domains/wms`'s
 * DOMAIN.md open decisions).
 */
export const AllocatePickTaskRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(ReceiveGoodsLineSchema).min(1),
});
export type AllocatePickTaskRequest = z.infer<typeof AllocatePickTaskRequestSchema>;

export const AllocatePickTaskResponseSchema = z.strictObject({
  taskIds: z.array(z.uuid()),
  shortLines: z.array(z.strictObject({ productId: z.uuid(), requestedQty: DecimalStringSchema, allocatedQty: DecimalStringSchema })),
});
export type AllocatePickTaskResponse = z.infer<typeof AllocatePickTaskResponseSchema>;

/** POST /gudang/putaway/{taskId}/konfirmasi — WMS-004. */
export const ConfirmPutawayRequestSchema = z.strictObject({
  toLocationCode: z.string().min(1),
  qtyConfirmed: DecimalStringSchema,
});
export type ConfirmPutawayRequest = z.infer<typeof ConfirmPutawayRequestSchema>;

export const WarehouseTaskOutcomeResponseSchema = z.strictObject({ taskId: z.uuid(), status: WarehouseTaskStatusSchema });
export type WarehouseTaskOutcomeResponse = z.infer<typeof WarehouseTaskOutcomeResponseSchema>;

/** GET /gudang/tugas-berikutnya?type= */
export const NextWarehouseTaskSchema = z.strictObject({
  id: z.uuid(),
  locationCode: z.string(),
  productId: z.uuid(),
  uom: z.string(),
  qtyExpected: DecimalStringSchema,
});
export const NextWarehouseTaskResponseSchema = z.strictObject({ task: NextWarehouseTaskSchema.nullable() });
export type NextWarehouseTaskResponse = z.infer<typeof NextWarehouseTaskResponseSchema>;

/**
 * POST /gudang/tugas/{taskId}/konfirmasi — WMS-006, SCAN -> CONFIRM -> NEXT. `scannedBarcode` (what
 * a handheld scanner actually reads) is resolved to a `productId` server-side before the domain
 * command's own mismatch check runs; `scannedProductId` is accepted directly for callers that
 * already resolved it (e.g. a retry, or a client without camera access).
 */
export const ConfirmPickTaskRequestSchema = z.strictObject({
  scannedLocationCode: z.string().min(1),
  scannedBarcode: z.string().min(1).optional(),
  scannedProductId: z.uuid().optional(),
  qtyConfirmed: DecimalStringSchema,
  shortReasonCode: z.string().min(1).optional(),
}).refine((value) => Boolean(value.scannedBarcode) !== Boolean(value.scannedProductId), 'Exactly one of scannedBarcode or scannedProductId is required.');
export type ConfirmPickTaskRequest = z.infer<typeof ConfirmPickTaskRequestSchema>;

/** POST /gudang/hitung — WMS-010 (blind count). */
export const SubmitCycleCountRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  locationCode: z.string().min(1),
  productId: z.uuid(),
  uom: z.string().min(1),
  countedQty: DecimalStringSchema,
});
export type SubmitCycleCountRequest = z.infer<typeof SubmitCycleCountRequestSchema>;

export const CycleCountResponseSchema = z.strictObject({
  taskId: z.uuid(),
  varianceDetected: z.boolean(),
  discrepancyReportId: z.uuid().optional(),
});
export type CycleCountResponse = z.infer<typeof CycleCountResponseSchema>;
