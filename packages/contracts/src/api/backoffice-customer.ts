import { z } from 'zod';

/**
 * Pelanggan — the back office's read-only customer list (MDM-004).
 *
 * Read-only on purpose: this screen exists so an operator can look a customer up, not edit one.
 * Registering and reviewing a customer is `createCustomer`'s path (PENDING_REVIEW), which the POS
 * quick-register flow uses; nothing here writes.
 *
 * `phone` is PERSONAL data (AGENTS.md §15). It is shown because an operator identifies a customer by
 * it at the counter, and it is never written to a log or an event by anything in this file.
 *
 * No permission code is registered for reading a customer — MVP-OD-8 deliberately withheld every
 * master-data resource except the product. This list is gated on the steward permission the Barang
 * screen uses and the gap is recorded as MVP-OD-21.
 */

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
