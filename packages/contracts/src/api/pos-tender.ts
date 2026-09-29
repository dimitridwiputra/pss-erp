import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';

export const AcceptPosTenderRequestSchema = z.strictObject({
  method: z.literal('TUNAI'),
  cashReceived: MoneyAmountSchema,
});
export type AcceptPosTenderRequest = z.infer<typeof AcceptPosTenderRequestSchema>;

export const PosTenderResponseSchema = z.strictObject({
  id: z.uuid(),
  method: z.enum(['TUNAI', 'QRIS', 'TRANSFER']),
  status: z.enum(['ACCEPTED', 'PENDING_CONFIRMATION', 'VOIDED']),
  amount: MoneyAmountSchema,
  changeAmount: MoneyAmountSchema.nullable(),
});
export type PosTenderResponse = z.infer<typeof PosTenderResponseSchema>;

export const AcceptPosTenderResponseSchema = z.strictObject({
  tender: PosTenderResponseSchema,
  sale: z.strictObject({ id: z.uuid(), status: z.enum(['PENDING_PAYMENT', 'PAID']) }),
});
export type AcceptPosTenderResponse = z.infer<typeof AcceptPosTenderResponseSchema>;
