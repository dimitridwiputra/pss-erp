import { z } from 'zod';

/** POST /wms/warehouses/{warehouseId}/activate — WMS-002 (simplified). */
export const ActivateWarehouseResponseSchema = z.strictObject({
  warehouseId: z.uuid(),
  activatedAt: z.string(),
});
export type ActivateWarehouseResponse = z.infer<typeof ActivateWarehouseResponseSchema>;
