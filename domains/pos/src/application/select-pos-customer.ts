import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createCustomer } from '@pss/master-data';
import { withConnection } from '@pss/platform';
import { lockCart } from './pos-sale-cart';
import { parseOrThrow, RequestMetaShape } from './support/command-input';

const SelectPosCustomerSchema = z.strictObject({ saleId: z.uuid(), customerId: z.uuid(), ...RequestMetaShape });
export type SelectPosCustomerInput = z.input<typeof SelectPosCustomerSchema>;

/**
 * POS-004: attaches an already-known customer to a CART sale. Re-pricing happens on the next
 * AddPosSaleLine/checkout, not retroactively on existing lines in this slice. Not exposed by the
 * MVP API (the customer menu is hidden, MVP_PLAN §6.1).
 */
export async function selectPosCustomer(pool: Pool, client: PoolClient | undefined, raw: SelectPosCustomerInput): Promise<void> {
  const input = parseOrThrow(SelectPosCustomerSchema, raw);
  await withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const cart = await lockCart(client, input.saleId);
    await client.query('UPDATE pos.pos_sale SET customer_id = $2, version = version + 1, updated_at = now() WHERE id = $1', [input.saleId, input.customerId]);
    await appendAuditEntry({
      organizationId: cart.organizationId, branchId: cart.branchId, actor: input.actor, action: 'POS_SALE_CUSTOMER_SELECTED',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: cart.version + 1 },
      changes: [{ path: 'customerId', classification: 'INTERNAL', after: input.customerId }],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
  });
}

const QuickRegisterPosCustomerSchema = z.strictObject({
  saleId: z.uuid(), organizationId: z.uuid(), branchId: z.uuid().optional(),
  name: z.string().min(1), phone: z.string().min(1).optional(), npwp: z.string().min(1).optional(),
  ...RequestMetaShape,
});
export type QuickRegisterPosCustomerInput = z.input<typeof QuickRegisterPosCustomerSchema>;

/**
 * POS-004: quick-registers a new customer via master-data's own command (pos never writes the
 * customer table) and attaches it to the sale. `createCustomer` opens its own transaction, so the
 * two steps commit separately; a failed attach leaves a registered customer, which is harmless.
 */
export async function quickRegisterPosCustomer(pool: Pool, raw: QuickRegisterPosCustomerInput) {
  const input = parseOrThrow(QuickRegisterPosCustomerSchema, raw);
  const customer = await createCustomer(pool, {
    organizationId: input.organizationId, branchId: input.branchId, name: input.name, phone: input.phone, npwp: input.npwp,
    actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
  });
  await selectPosCustomer(pool, undefined, {
    saleId: input.saleId, customerId: customer.id,
    actor: input.actor, requestId: input.requestId, correlationId: input.correlationId, source: input.source,
  });
  return customer;
}
