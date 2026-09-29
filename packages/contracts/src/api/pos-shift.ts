import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';

export const OpenPosShiftRequestSchema = z.strictObject({
  terminalId: z.uuid(),
  openingFloat: MoneyAmountSchema,
});
export type OpenPosShiftRequest = z.infer<typeof OpenPosShiftRequestSchema>;

export const ClosePosShiftRequestSchema = z.strictObject({
  countedCash: MoneyAmountSchema,
  denominations: z.record(z.string(), z.number().int().nonnegative()).optional(),
  reasonCode: z.string().min(1).optional(),
  note: z.string().optional(),
});
export type ClosePosShiftRequest = z.infer<typeof ClosePosShiftRequestSchema>;

export const PosShiftResponseSchema = z.strictObject({
  id: z.uuid(),
  terminalId: z.uuid(),
  status: z.enum(['OPEN', 'CLOSED', 'CLOSED_WITH_DISCREPANCY', 'HANDED_OVER']),
  openingFloat: MoneyAmountSchema,
  expectedCash: MoneyAmountSchema.nullable(),
  countedCash: MoneyAmountSchema.nullable(),
  variance: MoneyAmountSchema.nullable(),
});
export type PosShiftResponse = z.infer<typeof PosShiftResponseSchema>;
