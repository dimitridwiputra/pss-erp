import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';
import { PosSaleLineResponseSchema } from './pos-sale';

/** POST /pos/sales/{id}/receipt-prints. The first print needs no reason; every later one is a "SALINAN" and does. */
export const PrintPosReceiptRequestSchema = z.strictObject({
  reprintReason: z.string().trim().min(1).max(200).optional(),
});
export type PrintPosReceiptRequest = z.infer<typeof PrintPosReceiptRequestSchema>;

/** POS-011 receipt content. The receipt carries the invoice number until DOC-001 receipt numbering is configured (GAP-16). */
export const PosReceiptResponseSchema = z.strictObject({
  saleId: z.uuid(),
  invoiceNumber: z.string(),
  terminalCode: z.string(),
  terminalName: z.string(),
  cashierUserId: z.uuid(),
  paidAt: z.iso.datetime(),
  copyNumber: z.int().positive(),
  isCopy: z.boolean(),
  lines: z.array(PosSaleLineResponseSchema),
  subtotal: MoneyAmountSchema,
  taxTotal: MoneyAmountSchema,
  total: MoneyAmountSchema,
  cashReceived: MoneyAmountSchema,
  changeAmount: MoneyAmountSchema,
});
export type PosReceiptResponse = z.infer<typeof PosReceiptResponseSchema>;
