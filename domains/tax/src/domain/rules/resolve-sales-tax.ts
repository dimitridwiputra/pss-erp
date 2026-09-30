import Decimal from 'decimal.js';
import { z } from 'zod';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import {
  ApplicableTaxRateSchema, CustomerTaxTreatmentSchema, SalesTaxCodeSchema, TaxCodeRecordSchema,
  type ApplicableTaxRate, type CustomerTaxTreatment, type SalesTaxCode, type TaxCodeRecord,
} from '../tax-code';
import { parseRoundingRule, taxAmount, zeroAmount, type RoundingRule } from './rounding-rule';

/** The registered configuration key whose value selects the rounding mode (TAX-000.R03). */
export const ROUNDING_RULE_CONFIG_KEY = 'tax.rounding_rule';

/** The registered configuration key that records whether output VAT is switched on. */
export const VAT_OUTPUT_RATE_CONFIG_KEY = 'tax.vat_output_rate';

/** The registered configuration key for input VAT, which is the purchase flow's rate, not this one. */
export const VAT_INPUT_RATE_CONFIG_KEY = 'tax.vat_input_rate';

/** `numeric(9,6)`, so a rate is reported with the precision the column stores. */
const RATE_SCALE = 6;

const ResolveSalesTaxInputSchema = z.strictObject({
  /**
   * The line's tax base: its net amount after discount (TAX-002.BR01). A decimal string, never a
   * JavaScript number (TAX-002.R01/NC02, DB.R04).
   */
  taxBase: DecimalStringSchema.refine((value) => new Decimal(value).gte(0), {
    message: 'Dasar pengenaan pajak tidak boleh negatif.',
  }),
  /**
   * The customer's recorded treatment, or null when master data holds none. Null is unresolved,
   * not "no tax": a line whose product code is itself unknown still fails (TAX-002.E1).
   */
  customerTaxTreatment: CustomerTaxTreatmentSchema,
  /** The product's own tax code. A product with none fails with `TAX_CODE_MISSING` (TAX-002.AC03). */
  productTaxCode: SalesTaxCodeSchema.nullable(),
  /** The document's business date in Asia/Jakarta (AGENTS.md §11.1), as an ISO date. */
  businessDate: z.iso.date(),
  /**
   * The rate rows in force on `businessDate`, already filtered by the caller. Passed as data so the
   * resolver has no database dependency and stays a pure function of its inputs (TAX-002.R02).
   */
  taxRates: z.array(ApplicableTaxRateSchema),
  /**
   * The tax code vocabulary, which is where `zero_rated` lives. Passed in rather than hard-coded so
   * the resolver holds no second copy of the code list (AGENTS.md §18).
   */
  taxCodes: z.array(TaxCodeRecordSchema),
  /**
   * The raw `tax.rounding_rule` value. Unset, KOSONG, or unrecognised fails closed when a rate is
   * actually applied (TAX-000.R03); a zero-rated code never reads it, because it has no amount to
   * round. Typed `unknown` because PLT-009 stores configuration as untyped JSON, and the decision
   * about which shapes are acceptable belongs in `parseRoundingRule`.
   */
  roundingRule: z.unknown(),
});
export type ResolveSalesTaxInput = z.input<typeof ResolveSalesTaxInputSchema>;

export interface ResolvedSalesTax {
  /** The code applied to the line, after the customer override. */
  taxCode: SalesTaxCode;
  /** The applied rate in percentage points; `'0'` for a zero-rated code. */
  rate: string;
  /** The tax base: the line's net amount after discount (TAX-002.BR01). */
  taxBase: string;
  /** The rounded tax amount, formatted as a `numeric(18,2)` decimal string. */
  taxAmount: string;
  /**
   * The rate row the amount came from, or null for a zero-rated code. A line without it cannot be
   * recalculated, which is the point: this snapshot is what makes an issued invoice immutable.
   */
  rateId: string | null;
  /** The rounding mode applied, or null when no amount was rounded. */
  roundingRule: RoundingRule | null;
}

/**
 * The tax code that applies to a sales line (TAX-002).
 *
 * The product's code is the default; a customer treatment of EXEMPT or NON_VAT overrides it, which
 * is the one override TAX-002 allows ("override per customer bila EXEMPT"). A product with no code
 * fails with `TAX_CODE_MISSING` rather than falling back to anything: guessing a product's tax code
 * is how a whole category ends up over- or under-taxed (TAX-002.AC03).
 */
function appliedTaxCode(input: z.output<typeof ResolveSalesTaxInputSchema>): SalesTaxCode {
  if (input.customerTaxTreatment === 'EXEMPT' || input.customerTaxTreatment === 'NON_VAT') {
    return input.customerTaxTreatment;
  }
  if (input.productTaxCode === null) throw new DomainError('TAX_CODE_MISSING');
  return input.productTaxCode;
}

/**
 * The rate in force on the business date (TAX-001.BR01).
 *
 * Overlapping ranges are impossible — `tax_rate_effective_range_excl` rejects them — so at most one
 * row matches. The latest `validFrom` wins regardless, which keeps this deterministic if it is ever
 * called with a caller that filtered less strictly than it should have.
 */
function rateForDate(
  code: SalesTaxCode,
  businessDate: string,
  taxRates: readonly ApplicableTaxRate[],
): ApplicableTaxRate | undefined {
  return taxRates
    .filter((rate) => rate.taxCode === code && rate.validFrom <= businessDate
      && (rate.validTo === null || businessDate < rate.validTo))
    .sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
}

/** The rate at the precision `core.tax_rate.rate` stores, so a snapshot reads back as written. */
function reportableRate(rate: string): string {
  return new Decimal(rate).toFixed(RATE_SCALE);
}

/**
 * TAX-002: the tax for one sales line, as a pure function of its inputs.
 *
 * Every failure mode is a `TAX_RATE_NOT_CONFIGURED` rejection carrying the specific missing piece
 * of configuration in a field error, because the registered copy for that code only says "the tax
 * rate has not been set" and an operator needs to be told *which* one. There is no partial success
 * and no default rate (TAX-001.NC01): a taxable line with no applicable rate does not compute at
 * all, because a silently zero-taxed invoice is the defect this resolver exists to remove.
 */
export function resolveSalesTax(input: ResolveSalesTaxInput): ResolvedSalesTax {
  const parsed = ResolveSalesTaxInputSchema.parse(input);
  const code = appliedTaxCode(parsed);
  const codeRecord = parsed.taxCodes.find((entry) => entry.code === code);

  if (codeRecord === undefined) {
    throw new DomainError('TAX_CODE_MISSING', ['Lengkapi Produk'], [{
      path: 'taxCode', code: 'unknown', message: `Kode pajak ${code} belum dikonfigurasi.`,
    }]);
  }

  if (codeRecord.zeroRated) {
    // EXEMPT and NON_VAT carry no rate, so neither a rate row nor a rounding rule is consulted.
    // Requiring either would block a legitimate zero-tax invoice on configuration it never uses.
    return {
      taxCode: code, rate: '0', taxBase: parsed.taxBase, taxAmount: zeroAmount(),
      rateId: null, roundingRule: null,
    };
  }

  const roundingRule = parseRoundingRule(parsed.roundingRule, { configKey: ROUNDING_RULE_CONFIG_KEY });
  const rate = rateForDate(code, parsed.businessDate, parsed.taxRates);
  if (rate === undefined) {
    throw new DomainError('TAX_RATE_NOT_CONFIGURED', ['Hubungi Finance'], [{
      path: 'taxCode', code: 'not_applicable_on_date',
      message: `Tarif pajak ${code} untuk tanggal ${parsed.businessDate} belum diatur.`,
    }]);
  }

  return {
    taxCode: code,
    rate: reportableRate(rate.rate),
    taxBase: parsed.taxBase,
    taxAmount: taxAmount({ taxBase: parsed.taxBase, rate: rate.rate, roundingRule }),
    rateId: rate.rateId,
    roundingRule,
  };
}

export type { ApplicableTaxRate, CustomerTaxTreatment, SalesTaxCode, TaxCodeRecord };