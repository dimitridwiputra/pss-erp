import type { Pool } from 'pg';
import { z } from 'zod';
import { createCustomer } from '@pss/master-data';
import { DomainError } from '@pss/contracts';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const SelectPosCustomerSchema = z.strictObject({ saleId: z.uuid(), customerId: z.uuid() });
export type SelectPosCustomerInput = z.input<typeof SelectPosCustomerSchema>;

/** POS-004: attaches an already-known customer to a CART sale. Re-pricing happens on the next AddPosSaleLine/checkout, not retroactively on existing lines in this slice. */
export async function selectPosCustomer(pool: Pool, raw: SelectPosCustomerInput): Promise<void> {
  const input = parseOrThrow(SelectPosCustomerSchema, raw);
  const sale = await pool.query<{ status: string }>('SELECT status FROM pos.pos_sale WHERE id = $1', [input.saleId]);
  if (!sale.rows[0]) throw new DomainError('NOT_FOUND');
  if (sale.rows[0].status !== 'CART') throw new DomainError('INVALID_STATE_TRANSITION');
  await pool.query('UPDATE pos.pos_sale SET customer_id = $2, updated_at = now() WHERE id = $1', [input.saleId, input.customerId]);
}

const QuickRegisterPosCustomerSchema = z.strictObject({
  saleId: z.uuid(), organizationId: z.uuid(), branchId: z.uuid().optional(),
  name: z.string().min(1), phone: z.string().min(1).optional(), npwp: z.string().min(1).optional(),
  actor: z.strictObject({ userId: z.uuid().optional(), roles: z.array(z.string()).default([]), serviceIdentity: z.string().optional() }),
  requestId: z.string().min(1), correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});
export type QuickRegisterPosCustomerInput = z.input<typeof QuickRegisterPosCustomerSchema>;

/** POS-004: quick-registers a new customer via master-data's own command (pos never writes the customer table) and attaches it to the sale. */
export async function quickRegisterPosCustomer(pool: Pool, raw: QuickRegisterPosCustomerInput) {
  const input = parseOrThrow(QuickRegisterPosCustomerSchema, raw);
  const customer = await createCustomer(pool, {
    organizationId: input.organizationId, branchId: input.branchId, name: input.name, phone: input.phone, npwp: input.npwp,
    actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
  });
  await selectPosCustomer(pool, { saleId: input.saleId, customerId: customer.id });
  return customer;
}
