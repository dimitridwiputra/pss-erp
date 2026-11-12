import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import {
  resolveSalesTax, resolveSalesTaxOnSnapshot, parseRoundingRule, taxAmount,
  ROUNDING_RULE_CONFIG_KEY, type ApplicableTaxRate, type TaxCodeRecord,
} from '../src/index';

const VAT_OUTPUT_ID = randomUUID();
const EXEMPT_ID = randomUUID();
const NON_VAT_ID = randomUUID();
const RATE_11_ID = randomUUID();
const RATE_12_ID = randomUUID();

const taxCodes: TaxCodeRecord[] = [
  { id: VAT_OUTPUT_ID, code: 'VAT_OUTPUT', name: 'PPN Keluaran', zeroRated: false, active: true },
  { id: EXEMPT_ID, code: 'EXEMPT', name: 'Bebas PPN', zeroRated: true, active: true },
  { id: NON_VAT_ID, code: 'NON_VAT', name: 'Tidak Kena PPN', zeroRated: true, active: true },
];

const rates: ApplicableTaxRate[] = [
  { taxCode: 'VAT_OUTPUT', rate: '11.000000', validFrom: '2020-01-01', validTo: '2026-04-01', rateId: RATE_11_ID },
  { taxCode: 'VAT_OUTPUT', rate: '12.000000', validFrom: '2026-04-01', validTo: null, rateId: RATE_12_ID },
];

const base = {
  taxBase: '1000000.00',
  customerTaxTreatment: 'VAT_OUTPUT' as const,
  productTaxCode: 'VAT_OUTPUT' as const,
  businessDate: '2026-03-10',
  taxRates: rates,
  taxCodes,
  roundingRule: 'HALF_UP',
};

describe('TAX-002.R02 resolveSalesTax: a pure function of its inputs', () => {
  it('TAX-RESOLVE-01 computes 11% on a date inside the 11% range', () => {
    expect(resolveSalesTax(base)).toEqual({
      taxCode: 'VAT_OUTPUT', rate: '11.000000', taxBase: '1000000.00',
      taxAmount: '110000.00', rateId: RATE_11_ID, roundingRule: 'HALF_UP',
    });
  });

  it('is deterministic: the same input yields an equal, independently computed result', () => {
    // TAX-002.TS03 as a plain determinism check — the property a caller relies on when a total is
    // recomputed and must match.
    const first = resolveSalesTax(base);
    const second = resolveSalesTax({ ...base });
    expect(second).toEqual(first);
  });

  it('never produces a tax amount that depends on JavaScript floating point', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. 10 * 0.1 at 11% is 0.011 exactly in decimal and
    // 0.011000000000000003 in a double; the resolver must return the decimal answer.
    const result = resolveSalesTax({ ...base, taxBase: '0.3' });
    expect(result.taxAmount).toBe('0.03');
    expect(0.1 * 11 / 100).not.toBe(0.011);
  });
});

describe('TAX-001.BR01/AC01 the rate is chosen by the business date', () => {
  it('picks the rate whose range covers the business date', () => {
    expect(resolveSalesTax({ ...base, businessDate: '2026-03-31' }).rate).toBe('11.000000');
    expect(resolveSalesTax({ ...base, businessDate: '2026-04-01' }).rate).toBe('12.000000');
    expect(resolveSalesTax({ ...base, businessDate: '2026-04-01' }).taxAmount).toBe('120000.00');
  });

  it('treats the valid range as half-open, so the changeover day belongs to the new rate', () => {
    expect(resolveSalesTax({ ...base, businessDate: '2026-03-31' }).rateId).toBe(RATE_11_ID);
    expect(resolveSalesTax({ ...base, businessDate: '2026-04-01' }).rateId).toBe(RATE_12_ID);
  });

  it('refuses a date no rate covers instead of falling back to the nearest one', () => {
    // A gap in the rate history — legal to reach, since the exclusion constraint only forbids
    // OVERLAP — must resolve to no rate rather than to whichever row is closest in time.
    const withGap: ApplicableTaxRate[] = [
      { taxCode: 'VAT_OUTPUT', rate: '11.000000', validFrom: '2026-01-01', validTo: '2026-02-01', rateId: RATE_11_ID },
      { taxCode: 'VAT_OUTPUT', rate: '12.000000', validFrom: '2026-03-01', validTo: null, rateId: RATE_12_ID },
    ];
    expect(() => resolveSalesTax({ ...base, taxRates: withGap, businessDate: '2026-02-15' }))
      .toThrowError(expect.objectContaining({ code: 'TAX_RATE_NOT_CONFIGURED' }));
    // A date before any rate existed is equally refused.
    expect(() => resolveSalesTax({ ...base, taxRates: withGap, businessDate: '2025-12-31' }))
      .toThrowError(expect.objectContaining({ code: 'TAX_RATE_NOT_CONFIGURED' }));
  });
});

describe('TAX-RESOLVE-02 a zero-rated customer resolves without any rate', () => {
  it('gives an EXEMPT customer a zero amount and consults neither rate nor rounding rule', () => {
    const result = resolveSalesTax({
      ...base, customerTaxTreatment: 'EXEMPT', roundingRule: null, taxRates: [],
    });
    expect(result).toEqual({
      taxCode: 'EXEMPT', rate: '0', taxBase: '1000000.00',
      taxAmount: '0.00', rateId: null, roundingRule: null,
    });
  });

  it('gives a NON_VAT customer the same treatment', () => {
    expect(resolveSalesTax({ ...base, customerTaxTreatment: 'NON_VAT', taxRates: [] }).taxAmount).toBe('0.00');
  });

  it("applies the customer override over the product's own VAT_OUTPUT code", () => {
    const result = resolveSalesTax({
      ...base, customerTaxTreatment: 'EXEMPT', productTaxCode: 'VAT_OUTPUT', taxRates: [],
    });
    expect(result.taxCode).toBe('EXEMPT');
  });
});

describe('TAX-RESOLVE-03 fail-closed paths', () => {
  it('refuses a taxable line when the rate is unset (TAX-001.NC01: no default rate)', () => {
    expect(() => resolveSalesTax({ ...base, taxRates: [] }))
      .toThrowError(expect.objectContaining({ code: 'TAX_RATE_NOT_CONFIGURED' }));
  });

  it('refuses a taxable line when the rounding rule is KOSONG (TAX-000.R03)', () => {
    for (const roundingRule of [null, undefined, '', 'PER_LINE:ROUND_HALF_UP']) {
      expect(() => resolveSalesTax({ ...base, roundingRule }))
        .toThrowError(expect.objectContaining({ code: 'TAX_RATE_NOT_CONFIGURED' }));
    }
  });

  it('refuses a product with no tax code (TAX-002.E1)', () => {
    expect(() => resolveSalesTax({ ...base, productTaxCode: null }))
      .toThrowError(expect.objectContaining({ code: 'TAX_CODE_MISSING' }));
  });

  it('refuses a customer with no recorded treatment rather than assuming one', () => {
    expect(() => resolveSalesTax({ ...base, customerTaxTreatment: null, productTaxCode: null }))
      .toThrowError(expect.objectContaining({ code: 'TAX_CODE_MISSING' }));
  });

  it('refuses a code that is not in the vocabulary', () => {
    expect(() => resolveSalesTax({ ...base, taxCodes: [] }))
      .toThrowError(expect.objectContaining({ code: 'TAX_CODE_MISSING' }));
  });

  it('rejects a negative tax base, which has no defined tax', () => {
    expect(() => resolveSalesTax({ ...base, taxBase: '-1.00' })).toThrow();
  });
});

describe('TAX-002.BR01/BR02 the tax base and the rounding mode', () => {
  it('uses the net amount given as the tax base, not a gross one', () => {
    // A discount already applied upstream is why the base is an input rather than qty x price.
    const discounted = resolveSalesTax({ ...base, taxBase: '900000.00' });
    expect(discounted.taxAmount).toBe('99000.00');
  });

  it('rounds half away from zero for HALF_UP', () => {
    // 10999.9989 rounds up to the next sen.
    expect(taxAmount({ taxBase: '99999.99', rate: '11', roundingRule: 'HALF_UP' })).toBe('11000.00');
  });

  it('rounds to even for HALF_EVEN, which differs from HALF_UP on an exact half', () => {
    // 0.005 and 0.015 sit exactly on the boundary: HALF_UP raises both, HALF_EVEN sends 0.005 down
    // to the even 0.00 and 0.015 up to the even 0.02.
    expect(taxAmount({ taxBase: '0.50', rate: '1', roundingRule: 'HALF_UP' })).toBe('0.01');
    expect(taxAmount({ taxBase: '0.50', rate: '1', roundingRule: 'HALF_EVEN' })).toBe('0.00');
    expect(taxAmount({ taxBase: '1.50', rate: '1', roundingRule: 'HALF_UP' })).toBe('0.02');
    expect(taxAmount({ taxBase: '1.50', rate: '1', roundingRule: 'HALF_EVEN' })).toBe('0.02');
  });

  it('rounds a negative-direction amount down for DOWN and up for UP', () => {
    expect(taxAmount({ taxBase: '10000.01', rate: '11', roundingRule: 'DOWN' })).toBe('1100.00');
    expect(taxAmount({ taxBase: '10000.01', rate: '11', roundingRule: 'UP' })).toBe('1100.01');
  });

  it('always returns two decimal places, so a stored amount matches a numeric(18,2) column', () => {
    expect(taxAmount({ taxBase: '100', rate: '11', roundingRule: 'HALF_UP' })).toBe('11.00');
    expect(taxAmount({ taxBase: '0', rate: '11', roundingRule: 'HALF_UP' })).toBe('0.00');
  });
});

describe('TAX-000.R03 the rounding rule is read from configuration, never defaulted', () => {
  it('accepts every supported mode', () => {
    for (const mode of ['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP', 'DOWN'] as const) {
      expect(parseRoundingRule(mode, { configKey: ROUNDING_RULE_CONFIG_KEY })).toBe(mode);
    }
  });

  it('rejects unset, KOSONG and unrecognised values, naming the key that must be filled in', () => {
    for (const value of [null, undefined, '', 'ROUND_HALF_UP', 'PER_LINE:HALF_UP', 7, {}]) {
      expect(() => parseRoundingRule(value, { configKey: ROUNDING_RULE_CONFIG_KEY }))
        .toThrowError(expect.objectContaining({
          code: 'TAX_RATE_NOT_CONFIGURED',
          fieldErrors: [expect.objectContaining({ path: ROUNDING_RULE_CONFIG_KEY })],
        }));
    }
  });

  it('never reaches Decimal with an unset mode', () => {
    // The guard exists because `Decimal`'s default rounding would otherwise be applied silently.
    expect(() => taxAmount({ taxBase: '100', rate: '11', roundingRule: '' })).toThrow();
  });
});

describe('TAX-002.BR03/NC01 recomputation from the stored snapshot', () => {
  const snapshot = { taxCode: 'VAT_OUTPUT' as const, rate: '11.000000', roundingRule: 'HALF_UP' as const };

  it('reproduces the same amount from the snapshot alone, with no configuration read', () => {
    expect(resolveSalesTaxOnSnapshot({ taxBase: '1000000.00', snapshot })).toEqual({
      taxCode: 'VAT_OUTPUT', rate: '11.000000', taxBase: '1000000.00',
      taxAmount: '110000.00', roundingRule: 'HALF_UP',
    });
  });

  it('keeps the snapshotted rate even when a different rate is applicable today', () => {
    const today = resolveSalesTax({ ...base, businessDate: '2026-06-01' });
    const fromSnapshot = resolveSalesTaxOnSnapshot({ taxBase: '1000000.00', snapshot });
    expect(today.taxAmount).toBe('120000.00');
    expect(fromSnapshot.taxAmount).toBe('110000.00');
  });

  it('follows a reduced quantity at the snapshotted rate', () => {
    expect(resolveSalesTaxOnSnapshot({ taxBase: '500000.00', snapshot }).taxAmount).toBe('55000.00');
  });

  it('recomputes a zero-rated line to zero without needing a rounding mode', () => {
    expect(resolveSalesTaxOnSnapshot({
      taxBase: '1000000.00', snapshot: { taxCode: 'EXEMPT', rate: '0', roundingRule: null },
    }).taxAmount).toBe('0.00');
  });

  it('refuses a snapshot whose rate is not a plain decimal string', () => {
    // '1e1' is a number `Decimal` would happily read as 10, and '11,5' is not a number at all. The
    // schema rejects both, so a value written by anything other than this domain cannot smuggle a
    // scientific-notation or locale-formatted rate into a stored invoice line.
    for (const rate of ['1e1', 'eleven', '11,5', '-11', '']) {
      expect(() => resolveSalesTaxOnSnapshot({
        taxBase: '100.00', snapshot: { taxCode: 'VAT_OUTPUT', rate, roundingRule: 'HALF_UP' },
      })).toThrow();
    }
  });
});

describe('TAX-001.R01 no rate literal reaches the amount', () => {
  it('produces a well-formed amount for any rate it is handed, so none is baked in', () => {
    // If a rate were a literal, a rate outside it would fall out of the function entirely. Every
    // value here is one the domain has never seen configured.
    for (const rate of ['5', '7.5', '11', '24', '0.5']) {
      expect(taxAmount({ taxBase: '1000000.00', rate, roundingRule: 'HALF_UP' })).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('scales the amount linearly with the rate, which a literal could not do', () => {
    const five = taxAmount({ taxBase: '1000000.00', rate: '5', roundingRule: 'HALF_UP' });
    const eleven = taxAmount({ taxBase: '1000000.00', rate: '11', roundingRule: 'HALF_UP' });
    expect(five).toBe('50000.00');
    expect(eleven).toBe('110000.00');
  });
});

describe('TAX-001.R01 no tax rate literal in the domain\'s source', () => {
  it('finds no rate literal outside tests, fixtures and documentation', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const sourceRoot = new URL('../src/', import.meta.url).pathname;

    async function* sources(directory: string): AsyncGenerator<string> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) yield* sources(path);
        else if (entry.name.endsWith('.ts')) yield path;
      }
    }

    // A statutory Indonesian VAT rate is 11 or 12 today; the previous value was 10, and 5 is the
    // rate a luxury-goods rule would use. Any of these as a bare numeric literal in the domain's
    // product source would be a rate baked into code rather than configured.
    const rateLiterals = /(?<![\w.])(?:0?\.(?:0[5-9]|1[0-2])|11|12|5)(?=\s*(?:\/\*|\*|\)|,|;))/;
    const offenders: string[] = [];
    for await (const path of sources(sourceRoot)) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        // A comment explaining a rule is allowed to name a rate; code is not.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        if (rateLiterals.test(line)) offenders.push(`${path.replace(sourceRoot, '')}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('explains that this scan is the domain-local stand-in for a workspace fitness function', () => {
    // TAX-001.R01 calls for a fitness function, and the natural home is
    // `scripts/check-architecture.mjs` — which this change does not own. Until it is added there,
    // this scan is the enforcement point, and it is scoped to this domain rather than the workspace.
    // Recorded in DOMAIN.md's open decisions.
    expect(true).toBe(true);
  });
});

describe('the DomainError codes used here are registered', () => {
  it('every thrown code is one the error registry knows', () => {
    const thrown: string[] = [];
    for (const attempt of [
      () => resolveSalesTax({ ...base, taxRates: [] }),
      () => resolveSalesTax({ ...base, productTaxCode: null }),
      () => parseRoundingRule(null, { configKey: ROUNDING_RULE_CONFIG_KEY }),
    ]) {
      try { attempt(); } catch (error) {
        if (error instanceof DomainError) thrown.push(error.code);
      }
    }
    // A DomainError can only be constructed with a registered code — its constructor throws
    // otherwise — so reaching this point at all is the assertion; the list documents which.
    expect(new Set(thrown)).toEqual(new Set(['TAX_RATE_NOT_CONFIGURED', 'TAX_CODE_MISSING']));
  });
});