import { z } from 'zod';

/**
 * The statutory tax code vocabulary of TAX-001, in English identifiers and user-visible names.
 *
 * These four codes are the PRD's own list (TAX-001 IN SCOPE), so they are declared here as a
 * value object rather than left as bare strings at the call sites. A code that is not in this
 * vocabulary cannot be stored (`core.tax_code.code` carries the same CHECK), cannot be resolved,
 * and cannot be snapshotted onto an invoice line.
 */
export const TaxCodeSchema = z.enum(['VAT_OUTPUT', 'VAT_INPUT', 'EXEMPT', 'NON_VAT']);
export type TaxCode = z.infer<typeof TaxCodeSchema>;

/**
 * The codes a *sales* document may resolve to. `VAT_INPUT` is input VAT on a supplier invoice
 * (TAX-003, the purchase flow) and is deliberately not selectable here: a customer treatment is a
 * statement about what PSS charges that customer, never about what a supplier charges PSS.
 */
export const SalesTaxCodeSchema = z.enum(['VAT_OUTPUT', 'EXEMPT', 'NON_VAT']);
export type SalesTaxCode = z.infer<typeof SalesTaxCodeSchema>;

export const TAX_CODE_NAMES: Record<TaxCode, string> = {
  VAT_OUTPUT: 'PPN Keluaran',
  VAT_INPUT: 'PPN Masukan',
  EXEMPT: 'Bebas PPN',
  NON_VAT: 'Tidak Kena PPN',
};

/**
 * A customer's tax treatment as master data records it: which of the three sales codes applies to
 * what PSS sells that customer.
 *
 * It is a subset of `SalesTaxCodeSchema` on purpose — see the note there. `null` means the customer
 * master has not recorded one, which is a distinct state from "no tax": it is unresolved, and an
 * unresolved treatment blocks a taxable invoice rather than defaulting to one (TAX-002.E1).
 */
export const CustomerTaxTreatmentSchema = SalesTaxCodeSchema.nullable();
export type CustomerTaxTreatment = z.infer<typeof CustomerTaxTreatmentSchema>;

/**
 * The tax code rows this domain stores. `zeroRated` mirrors `core.tax_code.zero_rated`: a
 * zero-rated code resolves to rate 0 without a rate row, and never fails for a missing one.
 */
export const TaxCodeRecordSchema = z.strictObject({
  id: z.uuid(),
  code: TaxCodeSchema,
  name: z.string().min(1),
  zeroRated: z.boolean(),
  active: z.boolean(),
});
export type TaxCodeRecord = z.infer<typeof TaxCodeRecordSchema>;

/**
 * One rate in force on a business date, as the resolver consumes it.
 *
 * `rate` is a percentage string (`'11.000000'` is 11%), matching `core.tax_rate.rate`. No rate
 * literal appears anywhere in this domain's code (TAX-001.R01); a rate only ever arrives as data
 * from the table or from an invoice's own snapshot.
 */
export const ApplicableTaxRateSchema = z.strictObject({
  taxCode: TaxCodeSchema,
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable(),
  rateId: z.uuid(),
});
export type ApplicableTaxRate = z.infer<typeof ApplicableTaxRateSchema>;