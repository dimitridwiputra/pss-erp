import { z } from 'zod';
import { MoneyAmountSchema } from '../primitives';

export const PosSaleStatusSchema = z.enum(['CART', 'PENDING_PAYMENT', 'PAID', 'CREDIT_APPROVED', 'HANDED_OVER', 'CANCELLED']);

export const AddPosSaleLineRequestSchema = z.strictObject({
  barcode: z.string().min(1).optional(),
  productId: z.uuid().optional(),
  uom: z.string().min(1).optional(),
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/),
}).refine((value) => Boolean(value.barcode) || Boolean(value.productId && value.uom), 'A barcode or productId+uom is required.');
export type AddPosSaleLineRequest = z.infer<typeof AddPosSaleLineRequestSchema>;

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

export const SelectPosCustomerRequestSchema = z.strictObject({
  customerId: z.uuid().optional(),
  quickRegister: z.strictObject({
    name: z.string().min(1),
    phone: z.string().min(1).optional(),
    npwp: z.string().min(1).optional(),
  }).optional(),
}).refine((value) => Boolean(value.customerId) !== Boolean(value.quickRegister), 'Exactly one of customerId or quickRegister is required.');
export type SelectPosCustomerRequest = z.infer<typeof SelectPosCustomerRequestSchema>;

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
