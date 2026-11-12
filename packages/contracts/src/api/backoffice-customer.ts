import { z } from 'zod';

/**
 * Pelanggan — the back office's read-only customer list (MDM-004).
 *
 * The one write here is the customer's PPN treatment (TAX-001 "default kode pajak per customer").
 * Registering and reviewing a customer is `createCustomer`'s path (PENDING_REVIEW), which the POS
 * quick-register flow uses.
 *
 * `phone` is PERSONAL data (AGENTS.md §15). It is shown because an operator identifies a customer by
 * it at the counter, and it is never written to a log or an event by anything in this file.
 *
 * No permission code is registered for reading a customer — MVP-OD-32 deliberately withheld every
 * master-data resource except the product. This list is gated on the steward permission the Barang
 * screen uses and the gap is recorded as MVP-OD-21.
 */

/** `VAT_OUTPUT` = PPN on; `NON_VAT` / `EXEMPT` = PPN off. */
export const CustomerTaxTreatmentSchema = z.enum(['VAT_OUTPUT', 'EXEMPT', 'NON_VAT']);

/** GET /master-data/customers */
export const CustomerListQuerySchema = z.strictObject({
  /** Matches code or name; wildcards typed by the operator are escaped, not honoured. */
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'INACTIVE', 'MERGED']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'code', 'createdAt']).default('name'),
});
export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;

export const CustomerListItemSchema = z.strictObject({
  customerId: z.uuid(),
  code: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  segment: z.string().nullable(),
  status: z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'INACTIVE', 'MERGED']),
  /** The branch's system customer, which an operator must not try to edit or charge to directly. */
  isWalkIn: z.boolean(),
  /** Whether this customer is charged PPN; `null` is "not set", which a sale refuses. */
  taxTreatment: CustomerTaxTreatmentSchema.nullable(),
  version: z.int().positive(),
  createdAt: z.iso.datetime(),
});
export const CustomerListResponseSchema = z.strictObject({
  items: z.array(CustomerListItemSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  hasMore: z.boolean(),
});
export type CustomerListResponse = z.infer<typeof CustomerListResponseSchema>;

/**
 * PUT /master-data/customers/:id/tax-treatment — turn PPN on or off for one customer, the walk-in
 * customer included. It applies to invoices prepared afterwards; an existing invoice keeps the tax it
 * was prepared with (TAX-002.NC01).
 */
export const SetCustomerTaxTreatmentRequestSchema = z.strictObject({
  taxTreatment: CustomerTaxTreatmentSchema,
  /** The version the screen loaded. A mismatch is STALE_DATA rather than a silent overwrite. */
  expectedVersion: z.int().positive().optional(),
});
export type SetCustomerTaxTreatmentRequest = z.infer<typeof SetCustomerTaxTreatmentRequestSchema>;
export const SetCustomerTaxTreatmentResponseSchema = z.strictObject({
  customerId: z.uuid(),
  taxTreatment: CustomerTaxTreatmentSchema,
  version: z.int().positive(),
});
export type SetCustomerTaxTreatmentResponse = z.infer<typeof SetCustomerTaxTreatmentResponseSchema>;
