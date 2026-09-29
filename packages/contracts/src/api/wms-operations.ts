import { z } from 'zod';
import { DecimalStringSchema } from '../primitives';
import { WarehouseTaskStatusSchema, WarehouseTaskTypeSchema } from './wms-task';

/** POST /gudang/heartbeat — real (not simulated) operator presence. */
export const HeartbeatRequestSchema = z.strictObject({ warehouseId: z.uuid(), currentTaskId: z.uuid().optional() });
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const ActiveOperatorSchema = z.strictObject({
  userId: z.uuid(), online: z.boolean(), lastSeenAt: z.string(), currentTaskType: z.string().nullable(),
});
export const ActiveOperatorsResponseSchema = z.strictObject({ operators: z.array(ActiveOperatorSchema) });
export type ActiveOperatorsResponse = z.infer<typeof ActiveOperatorsResponseSchema>;

/** POST /wms/exceptions/{id}/assign, /resolve, GET /wms/exceptions. */
export const ExceptionQueueItemSchema = z.strictObject({
  id: z.uuid(),
  exceptionType: z.enum(['SCAN_MISMATCH', 'SHORT_ALLOCATION', 'INVALID_LOCATION', 'DAMAGED_GOODS', 'COUNT_VARIANCE']),
  referenceType: z.string().nullable(),
  referenceId: z.uuid().nullable(),
  severity: z.enum(['LOW', 'NORMAL', 'HIGH']),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']),
  description: z.string().nullable(),
  assignedTo: z.uuid().nullable(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export const ExceptionQueueResponseSchema = z.strictObject({ items: z.array(ExceptionQueueItemSchema) });
export type ExceptionQueueResponse = z.infer<typeof ExceptionQueueResponseSchema>;

export const AssignExceptionRequestSchema = z.strictObject({ assignedTo: z.uuid() });
export type AssignExceptionRequest = z.infer<typeof AssignExceptionRequestSchema>;

/** GET /wms/locations/utilization?warehouseId= */
export const LocationUtilizationSchema = z.strictObject({
  locationId: z.uuid(), code: z.string(), type: z.string(), status: z.string(),
  qtyOnHand: DecimalStringSchema, capacityQty: DecimalStringSchema.nullable(), utilizationPct: z.number().nullable(),
});
export const LocationUtilizationResponseSchema = z.strictObject({ locations: z.array(LocationUtilizationSchema) });
export type LocationUtilizationResponse = z.infer<typeof LocationUtilizationResponseSchema>;

/** GET /wms/reports?warehouseId=&from=&to= — WMS-015 "Laporan Gudang". */
export const WarehouseReportKpisSchema = z.strictObject({
  receivingTurnaroundAvgMinutes: z.number().nullable(),
  putawaySlaPct: z.number().nullable(),
  pickAccuracyPct: z.number().nullable(),
  shortRatePct: z.number().nullable(),
  cycleCountAccuracyPct: z.number().nullable(),
  tasksPerActiveOperator: z.number().nullable(),
});
export const WarehouseReportDetailRowSchema = z.strictObject({
  taskId: z.uuid(), type: z.string(), status: z.string(), locationCode: z.string().nullable(), productId: z.uuid().nullable(),
  qtyExpected: DecimalStringSchema.nullable(), qtyConfirmed: DecimalStringSchema.nullable(), createdAt: z.string(), updatedAt: z.string(),
});
export const WarehouseReportResponseSchema = z.strictObject({
  warehouseId: z.uuid(), fromDate: z.iso.date(), toDate: z.iso.date(),
  kpis: WarehouseReportKpisSchema,
  throughputTrend: z.array(z.strictObject({ date: z.iso.date(), type: z.string(), count: z.number().int() })),
  taskTypeComposition: z.array(z.strictObject({ type: z.string(), count: z.number().int() })),
  shortReasonDistribution: z.array(z.strictObject({ reasonCode: z.string(), count: z.number().int() })),
  detailRows: z.array(WarehouseReportDetailRowSchema),
});
export type WarehouseReportResponse = z.infer<typeof WarehouseReportResponseSchema>;

/** GET /wms/tasks?warehouseId=&type=&status=&limit= — "Antrian Tugas Operasional" task queue. */
export const WarehouseTaskSummarySchema = z.strictObject({
  taskId: z.uuid(),
  type: WarehouseTaskTypeSchema,
  status: WarehouseTaskStatusSchema,
  locationCode: z.string().nullable(),
  productId: z.uuid().nullable(),
  uom: z.string().nullable(),
  qtyExpected: DecimalStringSchema.nullable(),
  qtyConfirmed: DecimalStringSchema.nullable(),
  assigneeUserId: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ListWarehouseTasksResponseSchema = z.strictObject({ tasks: z.array(WarehouseTaskSummarySchema) });
export type ListWarehouseTasksResponse = z.infer<typeof ListWarehouseTasksResponseSchema>;
