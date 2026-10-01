import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { parseCommandInput } from '../domain/rules/parse-command-input';

/** The sales codes a customer may be charged at; `VAT_INPUT` is the purchase flow's (TAX-003). */
export const CustomerTaxTreatmentValueSchema = z.enum(['VAT_OUTPUT', 'EXEMPT', 'NON_VAT']);

const SetCustomerTaxTreatmentInputSchema = z.strictObject({
  organizationId: z.uuid(),
  customerId: z.uuid(),
  taxTreatment: CustomerTaxTreatmentValueSchema,
  /** A screen that loaded the customer passes it, so a concurrent change is `STALE_DATA`, not overwritten. */
  expectedVersion: z.number().int().positive().optional(),
  ...OptionalAuditContextSchema.shape,
});
export type SetCustomerTaxTreatmentInput = z.input<typeof SetCustomerTaxTreatmentInputSchema>;

export interface CustomerTaxTreatmentSet {
  customerId: string;
  taxTreatment: z.infer<typeof CustomerTaxTreatmentValueSchema>;
  version: number;
}

/**
 * TAX-001 "default kode pajak per customer": records whether this customer is charged PPN
 * (`VAT_OUTPUT`) or not (`NON_VAT` / `EXEMPT`). Every customer takes the same path, the branch's
 * walk-in customer included — whether a counter sale carries PPN is that customer's treatment, not a
 * flag on the sale.
 *
 * The treatment is read by `invoicing` when an invoice is *prepared* and snapshotted onto its lines,
 * so changing it never re-prices an invoice that already exists (TAX-002.NC01).
 *
 * Setting the value already stored still writes an audit entry (ADR-0013 §4b) and keeps the version.
 * A customer outside the caller's organization is `NOT_FOUND` (AGENTS.md §15).
 */
export async function setCustomerTaxTreatment(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: SetCustomerTaxTreatmentInput,
): Promise<CustomerTaxTreatmentSet> {
  const input = parseCommandInput(SetCustomerTaxTreatmentInputSchema, rawInput);

  const work = async (transaction: AuditedTransaction): Promise<CustomerTaxTreatmentSet> => {
    const current = await transaction.client.query<{ version: number; tax_treatment: string | null }>(
      `SELECT version, tax_treatment FROM core.customer
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.customerId, input.organizationId],
    );
    const row = current.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw new DomainError('STALE_DATA', ['Muat Ulang']);
    }

    const unchanged = row.tax_treatment === input.taxTreatment;
    const version = unchanged ? row.version : (await transaction.client.query<{ version: number }>(
      `UPDATE core.customer SET tax_treatment = $2, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING version`,
      [input.customerId, input.taxTreatment],
    )).rows[0]!.version;

    const auditContext = resolveAuditContext(input, input.customerId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'CUSTOMER_TAX_TREATMENT_SET',
      entity: { domain: 'master-data', type: 'Customer', id: input.customerId, version },
      changes: [{
        path: 'taxTreatment', classification: 'INTERNAL',
        before: row.tax_treatment ?? 'UNSET', after: input.taxTreatment,
      }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });
    return { customerId: input.customerId, taxTreatment: input.taxTreatment, version };
  };

  return withConnection(pool, client, work);
}
