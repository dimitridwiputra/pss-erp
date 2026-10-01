import { z } from 'zod';
import { DecimalStringSchema } from '@pss/contracts';
import { SalesTaxCodeSchema, type SalesTaxCode } from '../tax-code';
import { RoundingRuleSchema, taxAmount, zeroAmount, type RoundingRule } from './rounding-rule';

/**
 * What an invoice line records about the tax configuration it was priced under
 * (`sales.invoice_line.tax_code` / `tax_rate` / `tax_rounding_rule`).
 */
export const SalesTaxSnapshotSchema = z.strictObject({
  taxCode: SalesTaxCodeSchema,
  /** Percentage points, as stored on the line. */
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  /** Null for a zero-rated code, which had no rounding applied. */
  roundingRule: RoundingRuleSchema.nullable(),
});
export type SalesTaxSnapshot = z.infer<typeof SalesTaxSnapshotSchema>;

const ResolveSalesTaxOnSnapshotInputSchema = z.strictObject({
  taxBase: DecimalStringSchema,
  snapshot: SalesTaxSnapshotSchema,
});
export type ResolveSalesTaxOnSnapshotInput = z.input<typeof ResolveSalesTaxOnSnapshotInputSchema>;

export interface ResolvedSalesTaxSnapshot {
  taxCode: SalesTaxCode;
  rate: string;
  taxBase: string;
  taxAmount: string;
  roundingRule: RoundingRule | null;
}

/**
 * TAX-002.BR03/NC01 and AC02: recompute a line's tax from the snapshot the line already carries.
 *
 * This is how an issued invoice is never re-priced by later configuration. When a rate changes on
 * the 1st of next month, an invoice issued today keeps 11% because the recomputation reads the rate
 * stored on its own line rather than the row that happens to be in force now. AC02 states the same
 * rule for a credit note over a past invoice; the function is what both share.
 *
 * It exists because issuing an invoice legitimately changes quantities — a partial delivery reduces
 * the base — and the tax has to follow the quantity actually handed over. Recomputing from the
 * snapshot rather than from live configuration is what makes that a correction of quantity, not a
 * re-pricing of the document.
 *
 * A zero-rated snapshot recomputes to zero without needing a rounding rule, exactly as the original
 * resolution did: the rule was never consulted for it.
 */
export function resolveSalesTaxOnSnapshot(
  input: ResolveSalesTaxOnSnapshotInput,
): ResolvedSalesTaxSnapshot {
  const parsed = ResolveSalesTaxOnSnapshotInputSchema.parse(input);
  if (parsed.snapshot.roundingRule === null) {
    return {
      taxCode: parsed.snapshot.taxCode,
      rate: parsed.snapshot.rate,
      taxBase: parsed.taxBase,
      taxAmount: zeroAmount(),
      roundingRule: null,
    };
  }
  return {
    taxCode: parsed.snapshot.taxCode,
    rate: parsed.snapshot.rate,
    taxBase: parsed.taxBase,
    taxAmount: taxAmount({
      taxBase: parsed.taxBase, rate: parsed.snapshot.rate, roundingRule: parsed.snapshot.roundingRule,
    }),
    roundingRule: parsed.snapshot.roundingRule,
  };
}