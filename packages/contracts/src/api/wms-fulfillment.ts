import { z } from 'zod';
import { DecimalStringSchema } from '../primitives';

/** POST /wms/units — WMS-012 "Buat Koli". */
export const WarehouseUnitLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qty: DecimalStringSchema });
export const CreateWarehouseUnitRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  unitType: z.enum(['PALLET', 'CARTON', 'PACKAGE']),
  referenceType: z.string().min(1).optional(),
  referenceId: z.uuid().optional(),
  lines: z.array(WarehouseUnitLineSchema).default([]),
});
export type CreateWarehouseUnitRequest = z.infer<typeof CreateWarehouseUnitRequestSchema>;

export const WarehouseUnitResponseSchema = z.strictObject({ id: z.uuid(), code: z.string() });
export type WarehouseUnitResponse = z.infer<typeof WarehouseUnitResponseSchema>;

/** POST /gudang/koli/{code}/scan — WMS-007 "scan barang ke koli". */
export const AddWarehouseUnitLineRequestSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qty: DecimalStringSchema });
export type AddWarehouseUnitLineRequest = z.infer<typeof AddWarehouseUnitLineRequestSchema>;

/** POST /gudang/koli/selesai — WMS-007 "Selesai Pack". */
export const CompletePackingRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
});
export type CompletePackingRequest = z.infer<typeof CompletePackingRequestSchema>;

export const CompletePackingResponseSchema = z.strictObject({ taskId: z.uuid(), packageCount: z.number().int() });
export type CompletePackingResponse = z.infer<typeof CompletePackingResponseSchema>;

/** POST /gudang/stage — WMS-008. */
export const StagePackageRequestSchema = z.strictObject({ unitCode: z.string().min(1), laneCode: z.string().min(1) });
export type StagePackageRequest = z.infer<typeof StagePackageRequestSchema>;

/** POST /gudang/load — WMS-009. */
export const LoadPackageRequestSchema = z.strictObject({ unitCode: z.string().min(1), vehicleCode: z.string().min(1) });
export type LoadPackageRequest = z.infer<typeof LoadPackageRequestSchema>;

export const PackStageLoadOutcomeResponseSchema = z.strictObject({
  completed: z.boolean(),
  taskId: z.uuid().optional(),
});
export type PackStageLoadOutcomeResponse = z.infer<typeof PackStageLoadOutcomeResponseSchema>;

/** POST /wms/labels/print — WMS-012. */
export const PrintLabelRequestSchema = z.strictObject({ subjectType: z.enum(['LOCATION', 'UNIT']), subjectId: z.uuid() });
export type PrintLabelRequest = z.infer<typeof PrintLabelRequestSchema>;

export const PrintLabelResponseSchema = z.strictObject({ copyNumber: z.number().int() });
export type PrintLabelResponse = z.infer<typeof PrintLabelResponseSchema>;

/** POST /wms/reconciliation — WMS-013 (job trigger). */
export const RunReconciliationRequestSchema = z.strictObject({ warehouseId: z.uuid(), businessDate: z.iso.date() });
export type RunReconciliationRequest = z.infer<typeof RunReconciliationRequestSchema>;

export const ReconciliationItemSchema = z.strictObject({
  productId: z.uuid(), physicalQty: DecimalStringSchema, financialQty: DecimalStringSchema, variance: DecimalStringSchema,
});
export const ReconciliationResultResponseSchema = z.strictObject({
  id: z.uuid(), warehouseId: z.uuid(), businessDate: z.iso.date(), varianceCount: z.number().int(), items: z.array(ReconciliationItemSchema),
});
export type ReconciliationResultResponse = z.infer<typeof ReconciliationResultResponseSchema>;

/** GET /wms/dashboard?warehouseId= — WMS-015 (simplified; see DOMAIN.md open decisions on NC01). */
export const WarehouseDashboardResponseSchema = z.strictObject({
  asOf: z.string(),
  taskCounts: z.array(z.strictObject({ type: z.string(), status: z.string(), count: z.number().int() })),
  shortToday: z.number().int(),
  discrepanciesPendingReview: z.number().int(),
  cycleCountsPendingReview: z.number().int(),
  activeOperatorCount: z.number().int(),
  openExceptionCount: z.number().int(),
  stuckTasks: z.array(z.strictObject({
    taskId: z.uuid(), type: z.string(), status: z.string(), minutesSinceUpdate: z.number().int(), assigneeUserId: z.uuid().nullable(),
  })),
  pickAccuracyToday: z.number().nullable(),
  throughputPerHourToday: z.array(z.strictObject({ hour: z.number().int(), count: z.number().int() })),
});
export type WarehouseDashboardResponse = z.infer<typeof WarehouseDashboardResponseSchema>;

/** POST /gudang/sync — WMS-014 offline-queue replay. */
export const QueuedPickConfirmationSchema = z.strictObject({
  clientKey: z.string().min(1),
  kind: z.literal('PICK'),
  taskId: z.uuid(),
  scannedLocationCode: z.string().min(1),
  scannedProductId: z.uuid(),
  qtyConfirmed: DecimalStringSchema,
  shortReasonCode: z.string().min(1).optional(),
});
export const QueuedPutawayConfirmationSchema = z.strictObject({
  clientKey: z.string().min(1),
  kind: z.literal('PUTAWAY'),
  taskId: z.uuid(),
  toLocationCode: z.string().min(1),
  qtyConfirmed: DecimalStringSchema,
});
export const QueuedConfirmationSchema = z.discriminatedUnion('kind', [QueuedPickConfirmationSchema, QueuedPutawayConfirmationSchema]);
export type QueuedConfirmation = z.infer<typeof QueuedConfirmationSchema>;

export const SyncOfflineConfirmationsRequestSchema = z.strictObject({ confirmations: z.array(QueuedConfirmationSchema).min(1) });
export type SyncOfflineConfirmationsRequest = z.infer<typeof SyncOfflineConfirmationsRequestSchema>;

export const OfflineConfirmationResultSchema = z.strictObject({
  clientKey: z.string(), outcome: z.enum(['SAVED', 'NEEDS_REVIEW']), reason: z.string().nullable(),
});
export const SyncedOfflineConfirmationsResponseSchema = z.strictObject({
  status: z.enum(['APPLIED', 'APPLIED_WITH_CONFLICTS']),
  results: z.array(OfflineConfirmationResultSchema),
});
export type SyncedOfflineConfirmationsResponse = z.infer<typeof SyncedOfflineConfirmationsResponseSchema>;
