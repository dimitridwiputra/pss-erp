import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';
import { PosSaleLineResponseSchema } from './pos-sale';

/** GET /pos/pickups — paid counter sales whose goods are waiting, in warehouses the caller serves. */
export const PosPickupListResponseSchema = z.strictObject({
  items: z.array(z.strictObject({
    saleId: z.uuid(),
    invoiceNumber: z.string(),
    total: MoneyAmountSchema,
    paidAt: z.iso.datetime(),
    lines: z.array(PosSaleLineResponseSchema),
  })),
});
export type PosPickupListResponse = z.infer<typeof PosPickupListResponseSchema>;

/** POST /pos/sales/{id}/pickup-handover (POS-010). The staff member is the caller. */
export const ConfirmPosPickupHandoverRequestSchema = z.strictObject({
  receiverName: z.string().trim().min(1).max(120),
});
export type ConfirmPosPickupHandoverRequest = z.infer<typeof ConfirmPosPickupHandoverRequestSchema>;

export const ConfirmPosPickupHandoverResponseSchema = z.strictObject({
  saleId: z.uuid(),
  status: z.literal('HANDED_OVER'),
  invoiceNumber: z.string(),
  invoiceTotal: MoneyAmountSchema,
});
export type ConfirmPosPickupHandoverResponse = z.infer<typeof ConfirmPosPickupHandoverResponseSchema>;
