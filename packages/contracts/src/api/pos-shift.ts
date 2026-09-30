import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';

/** Money a person types at the counter: non-negative, at most 2 places. */
export const CounterMoneyInputSchema = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);

export const PosShiftStatusSchema = z.enum(['OPEN', 'CLOSED', 'CLOSED_WITH_DISCREPANCY', 'HANDED_OVER']);

/** POST /pos/shifts. The cashier is the caller; it is never a body field. */
export const OpenPosShiftRequestSchema = z.strictObject({
  terminalId: z.uuid(),
  openingFloat: CounterMoneyInputSchema,
});
export type OpenPosShiftRequest = z.infer<typeof OpenPosShiftRequestSchema>;

/** POST /pos/shifts/{id}/close. `reasonCode` is a registered RC-POS-* code, required when the count differs. */
export const ClosePosShiftRequestSchema = z.strictObject({
  countedCash: CounterMoneyInputSchema,
  denominations: z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative()).optional(),
  reasonCode: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});
export type ClosePosShiftRequest = z.infer<typeof ClosePosShiftRequestSchema>;

export const PosShiftResponseSchema = z.strictObject({
  id: z.uuid(),
  terminalId: z.uuid(),
  status: PosShiftStatusSchema,
  openingFloat: MoneyAmountSchema,
  expectedCash: MoneyAmountSchema.nullable(),
  countedCash: MoneyAmountSchema.nullable(),
  variance: MoneyAmountSchema.nullable(),
});
export type PosShiftResponse = z.infer<typeof PosShiftResponseSchema>;

/** POST /pos/shifts/{id}/cash-handover (POS-014). `declaredAmount` excludes the opening float, which stays in the drawer. */
export const DeclarePosCashHandoverResponseSchema = z.strictObject({
  cashCustodyRecordId: z.uuid(),
  declaredAmount: MoneyAmountSchema,
  openingFloat: MoneyAmountSchema,
});
export type DeclarePosCashHandoverResponse = z.infer<typeof DeclarePosCashHandoverResponseSchema>;
