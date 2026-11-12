import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { BusinessDateSchema, DomainError } from '@pss/contracts';
import { CustomerTaxTreatmentSchema, SalesTaxCodeSchema, type SalesTaxCode } from '../domain/tax-code';
import { resolveSalesTax, VAT_OUTPUT_RATE_CONFIG_KEY } from '../domain/rules/resolve-sales-tax';
import type { RoundingRule } from '../domain/rules/rounding-rule';
import {
  loadConfigValueInForce, loadTaxResolutionContext, type LoadTaxContextInput,
} from './tax-rate-resolver';

const SalesTaxLineInputSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  /**
   * The line's net amount after discount (TAX-002.BR01, COM-003), as a decimal string. `invoicing`
   * computes it server-side from qty and unit price; nothing here re-derives it, because a second
   * derivation would be a second answer to the same question (AGENTS.md §18).
   */
  taxBase: z.string().regex(/^\d+(\.\d+)?$/),
  /** The product's tax code, or null when the product master has none (TAX-002.E1). */
  productTaxCode: SalesTaxCodeSchema.nullable(),
});

const CalculateSalesTaxInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  businessDate: BusinessDateSchema,
  /** The customer's tax treatment from master data; null when none is recorded. */
  customerTaxTreatment: CustomerTaxTreatmentSchema,
  lines: z.array(SalesTaxLineInputSchema).min(1),
});
export type CalculateSalesTaxInput = z.input<typeof CalculateSalesTaxInputSchema>;

export interface CalculatedLineTax {
  productId: string;
  uom: string;
  taxCode: SalesTaxCode;
  /** Percentage points; `'0'` for a zero-rated code. Never a literal (TAX-001.R01). */
  rate: string;
  taxBase: string;
  taxAmount: string;
  /** The rate row the amount came from, or null for a zero-rated code. */
  rateId: string | null;
  /** The configured mode name, so the stored snapshot reads as what Finance set. */
  roundingRule: RoundingRule | null;
}

export interface CalculatedSalesTax {
  lines: CalculatedLineTax[];
  /** The document total, summed from the per-line amounts the resolver produced. */
  taxTotal: string;
  roundingRule: RoundingRule | null;
  businessDate: string;
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.',
  }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

/**
 * Whether any line of this document would actually carry a rate.
 *
 * A line whose applied code is rate-bearing needs both the `tax.vat_output_rate` gate and the
 * rounding rule; a zero-rated line needs neither, because its amount is zero without a computation.
 * Deciding this before reading anything is what lets an exempt invoice be issued without the tax
 * configuration being touched at all (TAX-000.R03's KOSONG blocks the documents that need the value,
 * not the ones that never use it).
 */
function chargesTax(input: z.output<typeof CalculateSalesTaxInputSchema>): boolean {
  const customerZeroRated = input.customerTaxTreatment === 'EXEMPT' || input.customerTaxTreatment === 'NON_VAT';
  if (customerZeroRated) return false;
  return input.lines.some((line) => line.productTaxCode !== 'EXEMPT' && line.productTaxCode !== 'NON_VAT');
}

/**
 * TAX-002, from a caller's point of view: hand it a document's lines and it returns each line's
 * tax code, rate, base and amount.
 *
 * The whole document resolves against one context — one set of rates, one rounding rule, one
 * business date — so every line of one invoice is computed from the same configuration even if a
 * rate is activated by a concurrent request halfway through.
 *
 * `tax.vat_output_rate` (a registered configuration key, SENSITIVE, owner CONTROLLER) is read only
 * to establish that this organization is registered to charge output VAT. Its value is never used as
 * the rate: the rate comes from the effective-dated `core.tax_rate` row, which is what carries the
 * approval reference and the effective dating (TAX-001). An EXEMPT or NON_VAT customer, and a
 * document with no VAT_OUTPUT line, are not gated on it — a legitimate zero-tax invoice must not be
 * blocked by configuration it does not use. Input VAT is a separate path with its own key
 * (`tax.vat_input_rate`) and is never consulted here; this function only ever answers for sales.
 *
 * The rate and code reads take the caller's `client`, so the resolution is part of the caller's
 * transaction: a rate activated while the invoice is being prepared cannot produce one line at the
 * old rate and another at the new one. The configuration read is the exception, and the reason is
 * documented on `loadTaxResolutionContext`.
 */
export async function calculateSalesTax(
  pool: Pool,
  client: PoolClient,
  rawInput: CalculateSalesTaxInput,
): Promise<CalculatedSalesTax> {
  const input = parseOrThrow(CalculateSalesTaxInputSchema, rawInput);

  const context: LoadTaxContextInput = {
    organizationId: input.organizationId,
    branchId: input.branchId,
    businessDate: input.businessDate,
  };

  const carriesTax = chargesTax(input);
  if (carriesTax) {
    const outputVatEnabled = await loadConfigValueInForce(pool, VAT_OUTPUT_RATE_CONFIG_KEY, context);
    if (outputVatEnabled === null) {
      throw new DomainError('TAX_RATE_NOT_CONFIGURED', ['Hubungi Finance'], [{
        path: VAT_OUTPUT_RATE_CONFIG_KEY, code: 'unset',
        message: `Nilai ${VAT_OUTPUT_RATE_CONFIG_KEY} belum diatur. Hubungi Finance.`,
      }]);
    }
  }

  const resolution = await loadTaxResolutionContext(pool, client, context, { readRoundingRule: carriesTax });
  const lines: CalculatedLineTax[] = input.lines.map((line) => {
    const resolved = resolveSalesTax({
      taxBase: line.taxBase,
      customerTaxTreatment: input.customerTaxTreatment,
      productTaxCode: line.productTaxCode,
      businessDate: input.businessDate,
      taxRates: resolution.taxRates,
      taxCodes: resolution.taxCodes,
      roundingRule: resolution.roundingRule,
    });
    return {
      productId: line.productId,
      uom: line.uom,
      taxCode: resolved.taxCode,
      rate: resolved.rate,
      taxBase: resolved.taxBase,
      taxAmount: resolved.taxAmount,
      rateId: resolved.rateId,
      roundingRule: resolved.roundingRule,
    };
  });

  // SUM in SQL keeps the document total decimal-exact; the per-line amounts are already rounded, so
  // this is the tax the invoice carries (TAX-002.BR02 applied per line, per AC01's worked example).
  const summed = await client.query<{ tax_total: string }>(
    `SELECT COALESCE(SUM(tax_amount::numeric), 0) AS tax_total
     FROM (SELECT unnest($1::numeric[]) AS tax_amount) amounts`,
    [lines.map((line) => line.taxAmount)],
  );
  const taxTotal = summed.rows[0]?.tax_total;
  if (taxTotal === undefined) throw new Error('The sales tax total was not returned after summation.');

  return {
    lines,
    taxTotal,
    roundingRule: lines.find((line) => line.roundingRule !== null)?.roundingRule ?? null,
    businessDate: input.businessDate,
  };
}