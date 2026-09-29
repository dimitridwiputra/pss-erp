import { z } from 'zod';

export const RegisterPosTerminalRequestSchema = z.strictObject({
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1),
  deviceId: z.uuid().optional(),
});
export type RegisterPosTerminalRequest = z.infer<typeof RegisterPosTerminalRequestSchema>;

export const PosTerminalResponseSchema = z.strictObject({
  id: z.uuid(),
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export type PosTerminalResponse = z.infer<typeof PosTerminalResponseSchema>;
