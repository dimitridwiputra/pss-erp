import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInvoice } from '../src/application/prepare-invoice';
import { issueInvoice } from '../src/application/issue-invoice';
import {
  applyInvoiceSchemas, createTestDatabase, seedActiveTaxRate, seedCustomer, seedProduct,
  setTaxConfiguration,
} from './fixture';

let pool: pg.Pool;
let dropDatabase: () => Promise<void>;

/** One business date far enough in the past that no fixture row's valid_from matters. */
const BUSINESS_DATE = '2026-03-10';

function actor() {
  return { userId: randomUUID(), roles: ['SALES_ADMIN'] };
}

function auditContext() {
  return { actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const };
}

/**
 * A VAT_OUTPUT customer selling a VAT_OUTPUT product at an approved 11% rate, with the rounding
 * rule set. This is the ordinary taxable configuration every pricing assertion below builds on, so
 * it is one function rather than repeated per test — and each call gets its own organization, so
 * tests cannot leak rate rows or configuration into one another.
 */
async function seededTaxableSale(rate = '11.000000') {
  const organizationId = randomUUID();
  await setTaxConfiguration(pool, { organizationId, roundingRule: 'HALF_UP' });
  await seedActiveTaxRate(pool, { organizationId, rate });
  const customerId = await seedCustomer(pool, { organizationId, taxTreatment: 'VAT_OUTPUT' });
  const productId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });
  return { organizationId, customerId, productId };
}

beforeAll(async () => {
  const created = await createTestDatabase('pss_invoicing_test');
  pool = created.pool;
  dropDatabase = created.drop;
  await applyInvoiceSchemas(pool);
}, 60_000);

afterAll(async () => {
  // `beforeAll` failing means there is no database to drop; guarding keeps the original failure as
  // the reported one instead of a second error about a missing fixture.
  if (dropDatabase) await dropDatabase();
});

describe('invoicing: prepareInvoice', () => {
  it('reserves a sequential number per organization/year and computes the correct subtotal/total', async () => {
    const { organizationId, customerId, productId } = await seededTaxableSale();

    const first = await prepareInvoice(pool, undefined, {
      organizationId,
      branchCode: 'CMH',
      salesOrderId: randomUUID(),
      customerId,
      businessDate: BUSINESS_DATE,
      lines: [
        { productId, uom: 'CTN', qty: '2.000', unitPrice: '50000.00' },
        { productId, uom: 'PCS', qty: '3.000', unitPrice: '20000.00' },
      ],
      ...auditContext(),
    });

    expect(first.number).toMatch(/^INV-CMH-2026-000001$/);
    expect(first.subtotal).toBe('160000.00');
    // 11% of 160000.00 — the assertion that fails outright under the pre-fix behaviour, which stored
    // tax_total as 0 for every line.
    expect(first.taxTotal).toBe('17600.00');
    expect(first.total).toBe('177600.00');

    const invoiceRow = await pool.query(
      `SELECT status, subtotal, tax_total, total FROM sales.invoice WHERE id = $1`,
      [first.invoiceId],
    );
    expect(invoiceRow.rows[0]).toMatchObject({
      status: 'PREPARED', subtotal: '160000.00', tax_total: '17600.00', total: '177600.00',
    });

    const lineCount = await pool.query(
      `SELECT count(*)::int AS count FROM sales.invoice_line WHERE invoice_id = $1`,
      [first.invoiceId],
    );
    expect(lineCount.rows[0].count).toBe(2);

    const auditEntries = await pool.query(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'INVOICE_PREPARED'`,
      [first.invoiceId],
    );
    expect(auditEntries.rowCount).toBe(1);

    // A second invoice for the same organization/year advances the sequence rather than reusing it.
    const second = await prepareInvoice(pool, undefined, {
      organizationId,
      branchCode: 'CMH',
      salesOrderId: randomUUID(),
      customerId,
      businessDate: BUSINESS_DATE,
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    });
    expect(second.number).toMatch(/^INV-CMH-2026-000002$/);
  });

  it('never collides on the same number under concurrent calls for the same organization/year', async () => {
    const { organizationId, customerId, productId } = await seededTaxableSale();
    const callCount = 5;

    const results = await Promise.all(
      Array.from({ length: callCount }, () => prepareInvoice(pool, undefined, {
        organizationId,
        branchCode: 'SBY',
        salesOrderId: randomUUID(),
        customerId,
        businessDate: BUSINESS_DATE,
        lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
        ...auditContext(),
      })),
    );

    const numbers = results.map((result) => result.number);
    expect(new Set(numbers).size).toBe(callCount);

    const suffixes = numbers.map((number) => Number(number.slice(-6))).sort((a, b) => a - b);
    expect(suffixes).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('invoicing: issueInvoice', () => {
  it('transitions PREPARED to ISSUED and keeps totals unchanged when fully delivered', async () => {
    const { organizationId, customerId, productId } = await seededTaxableSale();
    const prepared = await prepareInvoice(pool, undefined, {
      organizationId,
      branchCode: 'JKT',
      salesOrderId: randomUUID(),
      customerId,
      businessDate: BUSINESS_DATE,
      lines: [
        { productId, uom: 'CTN', qty: '10.000', unitPrice: '1000.00' },
        { productId, uom: 'PCS', qty: '5.000', unitPrice: '2000.00' },
      ],
      ...auditContext(),
    });
    expect(prepared.subtotal).toBe('20000.00');
    expect(prepared.taxTotal).toBe('2200.00');

    const issued = await issueInvoice(pool, {
      invoiceId: prepared.invoiceId,
      deliveredLines: [
        { productId, uom: 'CTN', qtyDelivered: '10.000' },
        { productId, uom: 'PCS', qtyDelivered: '5.000' },
      ],
      invoiceDate: BUSINESS_DATE,
      ...auditContext(),
    });

    expect(issued).toMatchObject({
      invoiceId: prepared.invoiceId,
      number: prepared.number,
      subtotal: '20000.00',
      taxTotal: '2200.00',
      total: '22200.00',
      status: 'ISSUED',
    });

    const invoiceRow = await pool.query(
      `SELECT status, invoice_date, total FROM sales.invoice WHERE id = $1`,
      [prepared.invoiceId],
    );
    expect(invoiceRow.rows[0].status).toBe('ISSUED');

    const lineCount = await pool.query(
      `SELECT count(*)::int AS count FROM sales.invoice_line WHERE invoice_id = $1`,
      [prepared.invoiceId],
    );
    expect(lineCount.rows[0].count).toBe(2);

    const auditEntries = await pool.query(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'INVOICE_ISSUED'`,
      [prepared.invoiceId],
    );
    expect(auditEntries.rowCount).toBe(1);
  });

  it('recomputes subtotal, tax and total to the delivered qty and removes an undelivered line', async () => {
    const { organizationId, customerId, productId } = await seededTaxableSale();
    const undeliveredProductId = await seedProduct(pool, { organizationId, taxCode: 'VAT_OUTPUT' });
    const prepared = await prepareInvoice(pool, undefined, {
      organizationId,
      branchCode: 'JKT',
      salesOrderId: randomUUID(),
      customerId,
      businessDate: BUSINESS_DATE,
      lines: [
        { productId, uom: 'CTN', qty: '10.000', unitPrice: '1000.00' },
        { productId: undeliveredProductId, uom: 'PCS', qty: '5.000', unitPrice: '2000.00' },
      ],
      ...auditContext(),
    });

    const issued = await issueInvoice(pool, {
      invoiceId: prepared.invoiceId,
      // Only the first product is partially delivered (6 of 10); the second is entirely omitted.
      deliveredLines: [{ productId, uom: 'CTN', qtyDelivered: '6.000' }],
      invoiceDate: BUSINESS_DATE,
      ...auditContext(),
    });

    expect(issued.subtotal).toBe('6000.00');
    // The tax follows the quantity actually handed over, computed from the snapshot the prepared
    // line already carries — not from whatever rate is in force now.
    expect(issued.taxTotal).toBe('660.00');
    expect(issued.total).toBe('6660.00');

    const lines = await pool.query(
      `SELECT product_id, qty, line_total, tax_base, tax_amount FROM sales.invoice_line WHERE invoice_id = $1`,
      [prepared.invoiceId],
    );
    expect(lines.rowCount).toBe(1);
    expect(lines.rows[0]).toMatchObject({
      product_id: productId, qty: '6.000', line_total: '6000.00', tax_base: '6000.00', tax_amount: '660.00',
    });
  });

  it('throws INVALID_STATE_TRANSITION when the same invoice is issued twice', async () => {
    const { organizationId, customerId, productId } = await seededTaxableSale();
    const prepared = await prepareInvoice(pool, undefined, {
      organizationId,
      branchCode: 'JKT',
      salesOrderId: randomUUID(),
      customerId,
      businessDate: BUSINESS_DATE,
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    });

    const issueOnce = () => issueInvoice(pool, {
      invoiceId: prepared.invoiceId,
      deliveredLines: [{ productId, uom: 'CTN', qtyDelivered: '1.000' }],
      invoiceDate: BUSINESS_DATE,
      ...auditContext(),
    });

    await issueOnce();
    const secondAttempt = issueOnce();
    await expect(secondAttempt).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});