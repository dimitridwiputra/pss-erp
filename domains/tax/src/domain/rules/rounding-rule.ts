import Decimal from 'decimal.js';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';

/**
 * TAX-002.BR02: how a computed tax amount is rounded.
 *
 * The mode vocabulary is this domain's, and the value that selects one comes from the registered
 * `tax.rounding_rule` configuration key (SENSITIVE, owner CONTROLLER). PLT-009 stores that value
 * as untyped JSON, so nothing in the schema constrains it: an unrecognised value is rejected here
 * rather than defaulted, because a silent default is exactly what TAX-000.R03 forbids (the key's
 * default is KOSONG, and KOSONG is blocking).
 *
 * These are the rounding modes Indonesian VAT practice uses. `HALF_UP` is the historical default
 * for PPN (a half sen is rounded up to a sen); it is the value Finance/Tax must select explicitly,
 * never a fallback.
 *
 * Scope is deliberately NOT encoded in the value. TAX-002.BR02 says Finance/Tax decides per line
 * or per document, but TAX-002.AC01's worked example rounds a single line (`pembulatan(10.000.000
 * × r)`), so this slice implements per-line rounding and rejects a value that names a scope
 * rather than inventing a document-level allocation rule. Recorded as an open decision.
 */
export const RoundingModeSchema = z.enum(['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP', 'DOWN']);
export type RoundingMode = z.infer<typeof RoundingModeSchema>;

/**
 * `''` is KOSONG (TAX-000.R03's documented default) and parses here so the failure is reported by
 * `parseRoundingRule` with the key that has to be filled in, rather than by a schema error that
 * names no configuration at all.
 */
export const RoundingRuleSchema = z.union([RoundingModeSchema, z.literal('')]);
export type RoundingRule = z.infer<typeof RoundingRuleSchema>;

/** Money in this domain is decimal(18,2) (DB.R04), so a tax amount has two fraction digits. */
export const MONEY_SCALE = 2;

/**
 * A rate is stored in percentage points (`core.tax_rate.rate`), so a percentage has to be divided
 * by 100 to become a multiplier. That conversion is a unit change, not a rate: it is the only
 * place a `100` appears, and no statutory rate (11, 12, or any future one) is written in code.
 */
const PERCENT_SCALE = new Decimal(100);

const ROUNDING_MODES: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  HALF_DOWN: Decimal.ROUND_HALF_DOWN,
  UP: Decimal.ROUND_CEIL,
  DOWN: Decimal.ROUND_FLOOR,
};

export interface ParseRoundingRuleContext {
  /** The configuration key the value came from, quoted in the rejection's field error. */
  configKey: string;
}

/**
 * Reads `tax.rounding_rule` and fails closed when it is unset or unrecognised.
 *
 * KOSONG (empty string, null, or no row at all) throws `TAX_RATE_NOT_CONFIGURED` with the key
 * named, because the message has to tell an operator *which* piece of tax configuration is
 * missing — the registered copy for that code only mentions the rate, so the field error carries
 * the distinction the copy cannot.
 */
export function parseRoundingRule(rawValue: unknown, context: ParseRoundingRuleContext): RoundingRule {
  if (rawValue === null || rawValue === undefined) {
    throw new DomainError('TAX_RATE_NOT_CONFIGURED', ['Hubungi Finance'], [{
      path: context.configKey, code: 'unset',
      message: `Aturan pembulatan pajak ${context.configKey} belum diatur.`,
    }]);
  }
  // PLT-009 stores configuration values as JSON, so a number is a plausible thing for an operator
  // to enter. It is not silently coerced: an unrecognised shape is a decision that needs a human.
  const parsed = RoundingRuleSchema.safeParse(rawValue);
  if (!parsed.success) {
    throw new DomainError('TAX_RATE_NOT_CONFIGURED', ['Hubungi Finance'], [{
      path: context.configKey, code: 'unsupported_value',
      message: `Nilai ${context.configKey} tidak dikenali. Hubungi Finance.`,
    }]);
  }
  if (parsed.data === '') {
    throw new DomainError('TAX_RATE_NOT_CONFIGURED', ['Hubungi Finance'], [{
      path: context.configKey, code: 'empty_value',
      message: `Aturan pembulatan pajak ${context.configKey} belum diisi.`,
    }]);
  }
  return parsed.data;
}

export interface TaxAmountInput {
  /** The tax base: the line's net amount after discount (TAX-002.BR01), as a decimal string. */
  taxBase: string;
  /** Percentage points, e.g. `'11'` for 11%. */
  rate: string;
  roundingRule: RoundingRule;
}

/**
 * `round(taxBase × rate / 100)` per the configured mode, as a fixed 2-decimal decimal string.
 *
 * Decimal-only: `Decimal` from decimal.js carries the exact digits, and no intermediate value ever
 * passes through a JavaScript float (TAX-002.R01/NC02, DB.R04). `toFixed` is used rather than
 * `toString` so the result has the same shape as a `numeric(18,2)` column.
 */
export function taxAmount({ taxBase, rate, roundingRule }: TaxAmountInput): string {
  if (roundingRule === '') {
    // Unreachable through `resolveSalesTax`, which parses the rule first. Guarded rather than cast
    // so that KOSONG can never reach `Decimal`'s rounding as an `undefined` mode, which would round
    // by whatever the library's default happens to be — the silent default TAX-000.R03 forbids.
    throw new Error('A tax amount cannot be computed without a rounding mode.');
  }
  const unrounded = new Decimal(taxBase).mul(rate).div(PERCENT_SCALE);
  return unrounded.toDecimalPlaces(MONEY_SCALE, ROUNDING_MODES[roundingRule]).toFixed(MONEY_SCALE);
}

/** Zero money in the same fixed shape, so a zero-tax line is formatted like any other amount. */
export function zeroAmount(): string {
  return new Decimal(0).toFixed(MONEY_SCALE);
}