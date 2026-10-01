export {
  TaxCodeSchema, SalesTaxCodeSchema, CustomerTaxTreatmentSchema, TaxCodeRecordSchema,
  ApplicableTaxRateSchema, TAX_CODE_NAMES,
} from './domain/tax-code';
export type { TaxCode, SalesTaxCode, CustomerTaxTreatment, TaxCodeRecord, ApplicableTaxRate } from './domain/tax-code';

export {
  RoundingModeSchema, RoundingRuleSchema, MONEY_SCALE, parseRoundingRule, taxAmount, zeroAmount,
} from './domain/rules/rounding-rule';
export type { RoundingMode, RoundingRule, TaxAmountInput } from './domain/rules/rounding-rule';

export {
  resolveSalesTax, ROUNDING_RULE_CONFIG_KEY, VAT_OUTPUT_RATE_CONFIG_KEY, VAT_INPUT_RATE_CONFIG_KEY,
} from './domain/rules/resolve-sales-tax';
export type { ResolveSalesTaxInput, ResolvedSalesTax } from './domain/rules/resolve-sales-tax';

export { resolveSalesTaxOnSnapshot, SalesTaxSnapshotSchema } from './domain/rules/resolve-sales-tax-on-snapshot';
export type {
  ResolveSalesTaxOnSnapshotInput, ResolvedSalesTaxSnapshot, SalesTaxSnapshot,
} from './domain/rules/resolve-sales-tax-on-snapshot';

export {
  loadApplicableTaxRates, loadTaxCodes, loadConfigValueInForce, loadRoundingRule,
  loadTaxResolutionContext,
} from './application/tax-rate-resolver';
export type { LoadTaxContextInput, TaxResolutionContext } from './application/tax-rate-resolver';

export { scheduleTaxRate } from './application/schedule-tax-rate';
export type { ScheduleTaxRateInput, ScheduledTaxRate } from './application/schedule-tax-rate';

export { calculateSalesTax } from './application/calculate-sales-tax';
export type {
  CalculateSalesTaxInput, CalculatedSalesTax, CalculatedLineTax,
} from './application/calculate-sales-tax';

export { applyApprovalDecision, TAX_RATE_CHANGE_APPROVAL_TYPE } from './application/apply-approval-decision';