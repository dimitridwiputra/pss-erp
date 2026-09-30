import { z } from 'zod';

export const PosTerminalResponseSchema = z.strictObject({
  id: z.uuid(),
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export type PosTerminalResponse = z.infer<typeof PosTerminalResponseSchema>;

/** GET /kasir/terminals — terminals the caller may open a shift on; `inUse` means another shift is OPEN there. */
export const KasirTerminalListResponseSchema = z.strictObject({
  items: z.array(PosTerminalResponseSchema.extend({ inUse: z.boolean() })),
});
export type KasirTerminalListResponse = z.infer<typeof KasirTerminalListResponseSchema>;
