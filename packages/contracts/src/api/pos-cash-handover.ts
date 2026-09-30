import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';
import { CounterMoneyInputSchema } from './pos-shift';

/**
 * Setoran Kas (/kantor/setoran-kas): counter cash handovers waiting for Finance, and their
 * verification (POS-014, CSH-001). Guarded by `payments.cash_custody.verify` at the branch.
 */

export const CashHandoverStatusSchema = z.enum(['DECLARED', 'VERIFIED', 'DISCREPANCY', 'RESOLVED']);

/** GET /payments/cash-handovers?status=&page=&pageSize= */
export const CashHandoverListQuerySchema = z.strictObject({
  status: CashHandoverStatusSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type CashHandoverListQuery = z.infer<typeof CashHandoverListQuerySchema>;

export const CashHandoverSchema = z.strictObject({
  id: z.uuid(),
  status: CashHandoverStatusSchema,
  declaredAmount: MoneyAmountSchema,
  countedAmount: MoneyAmountSchema.nullable(),
  varianceAmount: MoneyAmountSchema.nullable(),
  reasonCode: z.string().nullable(),
  paymentCount: z.int().nonnegative(),
  declaredAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().nullable(),
  collectorName: z.string().nullable(),
  verifierName: z.string().nullable(),
  shift: z.strictObject({
    id: z.uuid(),
    terminalName: z.string(),
    openingFloat: MoneyAmountSchema,
    countedCash: MoneyAmountSchema.nullable(),
    closeVariance: MoneyAmountSchema.nullable(),
  }).nullable(),
});
export type CashHandover = z.infer<typeof CashHandoverSchema>;

export const CashHandoverListResponseSchema = z.strictObject({
  items: z.array(CashHandoverSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
});
export type CashHandoverListResponse = z.infer<typeof CashHandoverListResponseSchema>;

/**
 * POST /payments/cash-handovers/{id}/verify. A count that differs from the declaration needs a
 * registered RC-CSH-* reason (MVP-OD-9); the verifier is the caller and may not be the collector (SOD-06).
 */
export const VerifyCashHandoverRequestSchema = z.strictObject({
  countedAmount: CounterMoneyInputSchema,
  reasonCode: z.string().min(1).optional(),
});
export type VerifyCashHandoverRequest = z.infer<typeof VerifyCashHandoverRequestSchema>;
