import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';

export const PosSaleStatusSchema = z.enum(['CART', 'PENDING_PAYMENT', 'PAID', 'CREDIT_APPROVED', 'HANDED_OVER', 'CANCELLED']);

const CounterQuantitySchema = z.string().regex(/^\d{1,12}(\.\d{1,3})?$/).refine((value) => !/^0+(\.0+)?$/.test(value), 'Jumlah harus lebih dari nol.');

/** POST /pos/sales. The terminal and organization come from the shift. */
export const CreatePosSaleRequestSchema = z.strictObject({ shiftId: z.uuid() });
export type CreatePosSaleRequest = z.infer<typeof CreatePosSaleRequestSchema>;

/**
 * POST /pos/sales/{id}/lines — a scanned barcode, or a katalog pick of one product in one of its
 * units (MVP-OD-27). The product is resolved on the server either way; the client never supplies a
 * product name, SKU or price.
 */
export const AddPosSaleLineRequestSchema = z.union([
  z.strictObject({ barcode: z.string().trim().min(1).max(64), qty: CounterQuantitySchema.optional() }),
  z.strictObject({ productId: z.uuid(), uom: z.string().trim().min(1).max(16), qty: CounterQuantitySchema.optional() }),
]);
export type AddPosSaleLineRequest = z.infer<typeof AddPosSaleLineRequestSchema>;

/** PATCH /pos/sales/{id}/lines/{lineId} */
export const UpdatePosSaleLineRequestSchema = z.strictObject({ qty: CounterQuantitySchema });
export type UpdatePosSaleLineRequest = z.infer<typeof UpdatePosSaleLineRequestSchema>;

export const PosSaleLineResponseSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  uom: z.string(),
  qty: z.string(),
  unitPrice: MoneyAmountSchema,
  lineTotal: MoneyAmountSchema,
});
export type PosSaleLineResponse = z.infer<typeof PosSaleLineResponseSchema>;

export const AddPosSaleLineResponseSchema = PosSaleLineResponseSchema.extend({ saleTotal: MoneyAmountSchema });
export type AddPosSaleLineResponse = z.infer<typeof AddPosSaleLineResponseSchema>;

/** PATCH / DELETE line: the recomputed cart total. */
export const PosCartTotalResponseSchema = z.strictObject({ total: MoneyAmountSchema });
export type PosCartTotalResponse = z.infer<typeof PosCartTotalResponseSchema>;

export const SelectPosCustomerRequestSchema = z.strictObject({
  customerId: z.uuid().optional(),
  quickRegister: z.strictObject({
    name: z.string().min(1),
    phone: z.string().min(1).optional(),
    npwp: z.string().min(1).optional(),
  }).optional(),
}).refine((value) => Boolean(value.customerId) !== Boolean(value.quickRegister), 'Exactly one of customerId or quickRegister is required.');
export type SelectPosCustomerRequest = z.infer<typeof SelectPosCustomerRequestSchema>;

/** GET /pos/sales/{id} */
export const PosSaleResponseSchema = z.strictObject({
  id: z.uuid(),
  number: z.string().nullable(),
  status: PosSaleStatusSchema,
  customerId: z.uuid().nullable(),
  lines: z.array(PosSaleLineResponseSchema),
  subtotal: MoneyAmountSchema,
  taxTotal: MoneyAmountSchema,
  total: MoneyAmountSchema,
  invoiceNumber: z.string().nullable(),
  tender: z.strictObject({
    method: z.literal('TUNAI'),
    amount: MoneyAmountSchema,
    cashReceived: MoneyAmountSchema,
    changeAmount: MoneyAmountSchema,
    acceptedAt: z.iso.datetime(),
  }).nullable(),
});
export type PosSaleResponse = z.infer<typeof PosSaleResponseSchema>;

export const CheckoutPosSaleResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.literal('PENDING_PAYMENT'),
  salesOrderId: z.uuid(),
  invoiceNumber: z.string(),
  total: MoneyAmountSchema,
});
export type CheckoutPosSaleResponse = z.infer<typeof CheckoutPosSaleResponseSchema>;
