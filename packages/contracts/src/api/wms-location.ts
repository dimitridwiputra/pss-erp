import { z } from 'zod';
import { DecimalStringSchema } from '../primitives';

export const WarehouseLocationTypeSchema = z.enum(['ZONE', 'AISLE', 'RACK', 'BIN', 'RECEIVING', 'STAGING', 'QUARANTINE']);

export const RegisterWarehouseLocationRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  code: z.string().min(1),
  parentLocationId: z.uuid().optional(),
  type: WarehouseLocationTypeSchema,
  capacityQty: DecimalStringSchema.optional(),
});
export type RegisterWarehouseLocationRequest = z.infer<typeof RegisterWarehouseLocationRequestSchema>;

export const WarehouseLocationResponseSchema = z.strictObject({ id: z.uuid() });
export type WarehouseLocationResponse = z.infer<typeof WarehouseLocationResponseSchema>;

export const SetWarehouseLocationStatusRequestSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'BLOCKED']),
});
export type SetWarehouseLocationStatusRequest = z.infer<typeof SetWarehouseLocationStatusRequestSchema>;

export const WarehouseLocationStatusResponseSchema = z.strictObject({ id: z.uuid(), status: z.enum(['ACTIVE', 'BLOCKED']) });
export type WarehouseLocationStatusResponse = z.infer<typeof WarehouseLocationStatusResponseSchema>;
