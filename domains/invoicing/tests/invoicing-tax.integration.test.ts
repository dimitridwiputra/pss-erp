import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import { prepareInvoice } from '../src/application/prepare-invoice';
import { issueInvoice } from '../src/application/issue-invoice';
import {
  applyInvoiceSchemas, createTestDatabase, seedActiveTaxRate, seedCustomer, seedProduct,
  seedZeroRatedTaxCodes, setTaxConfiguration, supersedeTaxRate,
} from './fixture';

let pool: pg.Pool;
let dropDatabase: () => Promise<void>;

function auditContext() {
  return {
    actor: { userId: randomUUID(), roles: ['SALES_ADMIN'] },
    requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const,
  };
}

async function invoiceLines(invoiceId: string) {
  const { rows } = await pool.query(
    `SELECT tax_code, tax_rate::text AS tax_rate, tax_base::text AS tax_base,
            tax_rounding_rule, tax_amount::text AS tax_amount, line_total::text AS line_total
     FROM sales.invoice_line WHERE invoice_id = $1 ORDER BY id`,
    [invoiceId],
  );
  return rows;
}

async function invoiceRow(invoiceId: string) {
  const { rows } = await pool.query(
    `SELECT status, tax_total::text AS tax_total, total::text AS total,
            tax_rounding_rule
     FROM sales.invoice WHERE id = $1`,
    [invoiceId],
  );
  return rows[0];
}

beforeAll(async () => {
  const created = await createTestDatabase('pss_invoicing_tax_test');
  pool = created.pool;
  dropDatabase = created.drop;
  await applyInvoiceSchemas(pool);
  await seedZeroRatedTaxCodes(pool);
}, 60_000);

afterAll(async () => {
  // `beforeAll` failing means there is no database to drop; guarding keeps the original failure as
  // the reported one instead of a second error about a missing fixture.
  if (dropDatabase) await dropDatabase();
});

describe('TAX-RESOLVE-01: a VAT-taxable customer is charged at the applicable rate', () => {
  it('computes 11% PPN on the line and stores the code, rate and rule with it', async () => {
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });

    const prepared = await prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '10.000', unitPrice: '100000.00' }],
      ...auditContext(),
    });

    // 10 x 100000.00 = 1,000,000.00 net; 11% is 110,000.00.
    expect(prepared.subtotal).toBe('1000000.00');
    expect(prepared.taxTotal).toBe('110000.00');
    expect(prepared.total).toBe('1110000.00');

    const [line] = await invoiceLines(prepared.invoiceId);
    expect(line).toMatchObject({
      tax_code: 'VAT_OUTPUT',
      tax_rate: '11.000000',
      tax_base: '1000000.00',
      tax_rounding_rule: 'HALF_UP',
      tax_amount: '110000.00',
    });
  });

  it('rounds a half-sen result by the configured mode rather than by a default', async () => {
    // 3 x 33333.33 = 99999.99 net; 11% = 10999.9989, so the third decimal is where the rule shows.
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'DOWN' });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });

    const floored = await prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'PCS', qty: '3.000', unitPrice: '33333.33' }],
      ...auditContext(),
    });
    expect(floored.taxTotal).toBe('10999.99');
  });
});

describe('TAX-RESOLVE-02: an exempt or non-VAT customer gets a valid zero-tax invoice', () => {
  for (const [treatment, code] of [['EXEMPT', 'EXEMPT'], ['NON_VAT', 'NON_VAT']] as const) {
    it(`issues a ${treatment} customer at zero tax without a configured output VAT rate`, async () => {
      const organizationId = randomUUID();
      // No rate row at all, and `tax.vat_output_rate` explicitly KOSONG: an exempt sale must be
      // issuable anyway, because it uses neither of them.
      await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP', outputVatEnabled: false });
      const customerId = await seedCustomer(pool, { organizationId, taxTreatment: treatment });
      const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });

      const prepared = await prepareInvoice(pool, undefined, {
        organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
        businessDate: '2026-03-10',
        lines: [{ productId, uom: 'CTN', qty: '4.000', unitPrice: '25000.00' }],
        ...auditContext(),
      });

      expect(prepared.subtotal).toBe('100000.00');
      expect(prepared.taxTotal).toBe('0.00');
      expect(prepared.total).toBe('100000.00');

      const issued = await issueInvoice(pool, undefined, {
        invoiceId: prepared.invoiceId,
        deliveredLines: [{ productId, uom: 'CTN', qtyDelivered: '4.000' }],
        invoiceDate: '2026-03-10',
        ...auditContext(),
      });

      // Issuance succeeds — the customer override applies the zero-rated code even though the
      // product's own code is VAT_OUTPUT.
      expect(issued.status).toBe('ISSUED');
      expect(issued.taxTotal).toBe('0.00');
      const [line] = await invoiceLines(prepared.invoiceId);
      expect(line).toMatchObject({ tax_code: code, tax_amount: '0.00', tax_rounding_rule: null });
    });
  }
});

describe('TAX-RESOLVE-03: a taxable customer with no applicable rate is refused', () => {
  it('blocks preparation with TAX_RATE_NOT_CONFIGURED when no rate applies on the business date', async () => {
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });
    // Deliberately no rate row: this is the TAX-001.AC02 / TAX-002.E1 blocking case.

    const attempt = prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    });

    await expect(attempt).rejects.toThrow(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: 'TAX_RATE_NOT_CONFIGURED' });

    // Nothing was written: a refused invoice leaves no row and burns no invoice number.
    const invoices = await pool.query(
      `SELECT count(*)::int AS count FROM sales.invoice WHERE organization_id = $1`, [organizationId],
    );
    expect(invoices.rows[0].count).toBe(0);
    const sequence = await pool.query(
      `SELECT count(*)::int AS count FROM sales.invoice_number_sequence WHERE organization_id = $1`,
      [organizationId],
    );
    expect(sequence.rows[0].count).toBe(0);
  });

  it('blocks preparation when tax.vat_output_rate is KOSONG', async () => {
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP', outputVatEnabled: false });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });

    await expect(prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    })).rejects.toMatchObject({ code: 'TAX_RATE_NOT_CONFIGURED' });
  });

  it('blocks preparation when tax.rounding_rule is KOSONG', async () => {
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: null });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });

    await expect(prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    })).rejects.toMatchObject({ code: 'TAX_RATE_NOT_CONFIGURED' });
  });

  it('blocks preparation when the product has no tax code', async () => {
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: null });

    await expect(prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    })).rejects.toMatchObject({ code: 'TAX_CODE_MISSING' });
  });

  it('blocks preparation when the customer has no recorded tax treatment', async () => {
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: null });
    const productId = await seedProduct(pool, { organizationId, taxCode: null });

    await expect(prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    })).rejects.toMatchObject({ code: 'TAX_CODE_MISSING' });
  });
});

describe('TAX-RESOLVE-04: a rate change applies from its effective date only', () => {
  it('taxes an invoice dated D-1 at the old rate and one dated D at the new', async () => {
    const organizationId = randomUUID();
    const effectiveFrom = '2026-04-01';
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    // The predecessor's range is closed the way `scheduleTaxRate` closes it, and both rows are
    // approved, so the exclusion constraint's guarantee is what the two answers rest on.
    await seedActiveTaxRate(pool, {
      organizationId, rate: '11.000000', validFrom: '2020-01-01', validTo: effectiveFrom,
    });
    await seedActiveTaxRate(pool, { organizationId, rate: '12.000000', validFrom: effectiveFrom });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });

    const line = (businessDate: string) => prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId, businessDate,
      lines: [{ productId, uom: 'CTN', qty: '10.000', unitPrice: '100000.00' }],
      ...auditContext(),
    });

    const beforeChange = await line('2026-03-31');
    const onChange = await line('2026-04-01');

    expect(beforeChange.taxTotal).toBe('110000.00');
    expect(onChange.taxTotal).toBe('120000.00');
    expect((await invoiceLines(beforeChange.invoiceId))[0]?.tax_rate).toBe('11.000000');
    expect((await invoiceLines(onChange.invoiceId))[0]?.tax_rate).toBe('12.000000');
  });

  it('refuses a taxable invoice dated after the last applicable rate ends', async () => {
    const organizationId = randomUUID();
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    await seedActiveTaxRate(pool, {
      organizationId, rate: '11.000000', validFrom: '2020-01-01', validTo: '2026-04-01',
    });
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });

    // A gap in the rate history is fail-closed, not "use the nearest rate".
    await expect(prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-06-01',
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    })).rejects.toMatchObject({ code: 'TAX_RATE_NOT_CONFIGURED' });
  });
});

describe('TAX-RESOLVE-05: an issued invoice keeps the tax it was issued with', () => {
  it('leaves the code, rate and amount untouched after the master configuration changes', async () => {
    const organizationId = randomUUID();
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });

    const prepared = await prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '10.000', unitPrice: '100000.00' }],
      ...auditContext(),
    });
    const issued = await issueInvoice(pool, undefined, {
      invoiceId: prepared.invoiceId,
      deliveredLines: [{ productId, uom: 'CTN', qtyDelivered: '10.000' }],
      invoiceDate: '2026-03-10',
      ...auditContext(),
    });
    expect(issued.taxTotal).toBe('110000.00');

    // Every input to the tax result changes underneath the issued invoice: the customer's treatment,
    // the product's code, the rounding rule, and the rate itself.
    await pool.query(`UPDATE core.customer SET tax_treatment = 'EXEMPT' WHERE id = $1`, [customerId]);
    await pool.query(`UPDATE core.product SET tax_code = 'EXEMPT' WHERE id = $1`, [productId]);
    await pool.query(
      `UPDATE platform.config_value SET value = '"DOWN"'::jsonb
       WHERE key = 'tax.rounding_rule' AND organization_id = $1`, [organizationId],
    );
    await supersedeTaxRate(pool, {
      organizationId, rate: '5.000000', validFrom: '2026-03-11',
    });

    const row = await invoiceRow(prepared.invoiceId);
    expect(row).toMatchObject({ status: 'ISSUED', tax_total: '110000.00', total: '1110000.00' });
    const [line] = await invoiceLines(prepared.invoiceId);
    expect(line).toMatchObject({
      tax_code: 'VAT_OUTPUT', tax_rate: '11.000000', tax_amount: '110000.00', tax_base: '1000000.00',
    });
  });

  it('re-quantifying a prepared invoice uses the snapshotted rate, not the rate now in force', async () => {
    const organizationId = randomUUID();
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });

    const prepared = await prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '10.000', unitPrice: '100000.00' }],
      ...auditContext(),
    });

    // The rate changes before handover, by superseding it the way the domain does rather than rewriting
    // it. The prepared line keeps the rate the customer was quoted, and issuing a partial delivery
    // re-quantifies against that snapshot.
    await supersedeTaxRate(pool, { organizationId, rate: '12.000000', validFrom: '2026-03-11' });

    const issued = await issueInvoice(pool, undefined, {
      invoiceId: prepared.invoiceId,
      deliveredLines: [{ productId, uom: 'CTN', qtyDelivered: '5.000' }],
      invoiceDate: '2026-03-11',
      ...auditContext(),
    });

    // 5 x 100000.00 at the snapshotted 11%, not the 12% that is in force now.
    expect(issued.subtotal).toBe('500000.00');
    expect(issued.taxTotal).toBe('55000.00');
    const [line] = await invoiceLines(prepared.invoiceId);
    expect(line).toMatchObject({ tax_rate: '11.000000', tax_base: '500000.00', tax_amount: '55000.00' });
  });

  it('refuses to issue a line whose tax snapshot is missing rather than issuing it untaxed', async () => {
    const organizationId = randomUUID();
    const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
    const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });
    await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
    await seedActiveTaxRate(pool, { organizationId, rate: '11.000000' });

    const prepared = await prepareInvoice(pool, undefined, {
      organizationId, branchCode: 'JKT', salesOrderId: randomUUID(), customerId,
      businessDate: '2026-03-10',
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '100000.00' }],
      ...auditContext(),
    });
    // A row in the shape an invoice written before tax resolution existed has.
    await pool.query(
      `UPDATE sales.invoice_line SET tax_code = NULL, tax_rate = NULL, tax_base = NULL WHERE invoice_id = $1`,
      [prepared.invoiceId],
    );

    await expect(issueInvoice(pool, undefined, {
      invoiceId: prepared.invoiceId,
      deliveredLines: [{ productId, uom: 'CTN', qtyDelivered: '1.000' }],
      invoiceDate: '2026-03-10',
      ...auditContext(),
    })).rejects.toMatchObject({ code: 'TAX_RATE_NOT_CONFIGURED' });
  });
});