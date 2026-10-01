import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const GetCustomerTaxTreatmentInputSchema = z.strictObject({
  customerId: z.uuid(),
  organizationId: z.uuid(),
});
export type GetCustomerTaxTreatmentInput = z.input<typeof GetCustomerTaxTreatmentInputSchema>;

/** A customer's sales tax treatment, or null when master data records none. */
export type CustomerTaxTreatment = 'VAT_OUTPUT' | 'EXEMPT' | 'NON_VAT' | null;

const TREATMENT_PATTERN = /^(VAT_OUTPUT|EXEMPT|NON_VAT)$/;

interface CustomerRow {
  tax_treatment: string | null;
  status: string;
}

/**
 * The customer tax treatment that TAX-002 needs to decide a line's code.
 *
 * This is a query, not a mutation: master data owns the customer, and `tax` and `invoicing` read
 * it through this function rather than from `core.customer` directly (AGENTS.md §3.1). A product's
 * own tax code is a separate fact master data does not yet hold (see `DOMAIN.md` open decisions),
 * which is why this returns the treatment alone.
 *
 * `null` is a real answer, not a failure: it means the customer has no recorded treatment and the
 * caller must resolve nothing — `resolveSalesTax` refuses a taxable line in that state. It is
 * distinct from `NOT_FOUND`, which means the customer id does not exist in this organization, and
 * an MERGED or INACTIVE customer resolves its treatment normally: an issued invoice must be
 * reproducible, and a treatment that vanished when a customer was retired would not reproduce it.
 *
 * `client` is accepted so a caller inside a transaction reads the customer it will bill rather than
 * one that was renamed by a concurrent write between the read and the commit.
 */
export async function getCustomerTaxTreatment(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: GetCustomerTaxTreatmentInput,
): Promise<CustomerTaxTreatment> {
  const input = parseCommandInput(GetCustomerTaxTreatmentInputSchema, rawInput);
  const executor = client ?? pool;
  const result = await executor.query<CustomerRow>(
    `SELECT tax_treatment, status FROM core.customer WHERE id = $1 AND organization_id = $2`,
    [input.customerId, input.organizationId],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError('NOT_FOUND');

  const treatment = row.tax_treatment;
  // The column's CHECK already restricts the vocabulary, so a value that does not match it means
  // the schema and this reader disagree. Refusing is the safe direction: guessing a treatment would
  // charge or waive tax on a guess.
  if (treatment === null) return null;
  if (!TREATMENT_PATTERN.test(treatment)) {
    throw new Error(`Customer ${input.customerId} has an unrecognised tax treatment: ${treatment}`);
  }
  return treatment as CustomerTaxTreatment;
}