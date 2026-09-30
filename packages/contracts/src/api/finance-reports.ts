import { z } from 'zod';

export const FinancePageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const FinanceDateRangeQuerySchema = z.strictObject({
  from: z.iso.date(), to: z.iso.date(),
}).refine((value) => value.from <= value.to, { message: 'Tanggal akhir harus setelah tanggal awal.' });

export const FinanceThroughQuerySchema = z.strictObject({ through: z.iso.date() });

export const FinanceLedgerQuerySchema = z.strictObject({
  accountCode: z.string().regex(/^[1-6]-\d{4}$/),
  from: z.iso.date(), to: z.iso.date(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((value) => value.from <= value.to, { message: 'Tanggal akhir harus setelah tanggal awal.' });

export const FinanceManualJournalSchema = z.strictObject({
  businessDate: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
  lines: z.array(z.strictObject({
    accountCode: z.string().regex(/^[1-6]-\d{4}$/),
    debit: z.string().regex(/^\d+\.\d{2}$/),
    credit: z.string().regex(/^\d+\.\d{2}$/),
    memo: z.string().trim().max(500).default(''),
  })).min(2).max(50),
});

export const FinanceReasonSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });
export const FinanceCloseSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  overrideExceptions: z.boolean().default(false),
});

export type FinanceManualJournalInput = z.infer<typeof FinanceManualJournalSchema>;
