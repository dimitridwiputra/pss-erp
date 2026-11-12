import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';
import { CounterMoneyInputSchema } from './pos-shift';

/** POST /pos/sales/{id}/tenders. TUNAI only in the MVP (QRIS/transfer are POS-007/008). */
export const AcceptPosTenderRequestSchema = z.strictObject({
  method: z.literal('TUNAI'),
  cashReceived: CounterMoneyInputSchema,
});
export type AcceptPosTenderRequest = z.infer<typeof AcceptPosTenderRequestSchema>;

export const PosTenderResponseSchema = z.strictObject({
  id: z.uuid(),
  method: z.enum(['TUNAI', 'QRIS', 'TRANSFER']),
  status: z.enum(['ACCEPTED', 'PENDING_CONFIRMATION', 'VOIDED']),
  amount: MoneyAmountSchema,
  cashReceived: MoneyAmountSchema.nullable(),
  changeAmount: MoneyAmountSchema.nullable(),
});
export type PosTenderResponse = z.infer<typeof PosTenderResponseSchema>;

export const AcceptPosTenderResponseSchema = z.strictObject({
  tender: PosTenderResponseSchema,
  sale: z.strictObject({ id: z.uuid(), status: z.literal('PAID') }),
});
export type AcceptPosTenderResponse = z.infer<typeof AcceptPosTenderResponseSchema>;
