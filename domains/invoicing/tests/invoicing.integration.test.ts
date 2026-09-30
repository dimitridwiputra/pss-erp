import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import { prepareInvoice } from '../src/application/prepare-invoice';
import { issueInvoice } from '../src/application/issue-invoice';
import { applyAuditMigrations, applyMigrations } from '../../../scripts/apply-migrations.mjs';

const databaseName = `pss_invoicing_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

function actor() {
  return { userId: randomUUID(), roles: ['SALES_ADMIN'] };
}

function auditContext() {
  return { actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const };
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });

  // The domain's full ordered list, plus platform for the outbox INVOICE_ISSUED is written to.
  await applyMigrations(pool, 'platform');
  await applyMigrations(pool, 'invoicing');

  // Every command audits through @pss/audit's withAuditedTransaction/runAuditedWork, which
  // inserts into audit.audit_entry — so that table must exist here too. The whole audit domain
  // is replayed, not one file: a fixture that applies only 0001 is what made amending a shipped
  // migration look safe (MIG-RISK-AUD-001).
  await applyAuditMigrations(pool);

}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('invoicing: prepareInvoice', () => {
  it('reserves a sequential number per organization/year and computes the correct subtotal/total', async () => {
    const organizationId = randomUUID();

    const first = await prepareInvoice(pool, undefined, {
      organizationId,
      branchCode: 'CMH',
      salesOrderId: randomUUID(),
      lines: [
        { productId: randomUUID(), uom: 'CTN', qty: '2.000', unitPrice: '50000.00' },
        { productId: randomUUID(), uom: 'PCS', qty: '3.000', unitPrice: '20000.00' },
      ],
      ...auditContext(),
    });

    expect(first.number).toMatch(/^INV-CMH-\d{4}-000001$/);
    expect(first.total).toBe('160000.00');

    const invoiceRow = await pool.query(
      `SELECT status, subtotal, tax_total, total FROM sales.invoice WHERE id = $1`,
      [first.invoiceId],
    );
    expect(invoiceRow.rows[0]).toMatchObject({ status: 'PREPARED', subtotal: '160000.00', tax_total: '0.00', total: '160000.00' });

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
      lines: [{ productId: randomUUID(), uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    });
    expect(second.number).toMatch(/^INV-CMH-\d{4}-000002$/);
  });

  it('never collides on the same number under concurrent calls for the same organization/year', async () => {
    const organizationId = randomUUID();
    const callCount = 5;

    const results = await Promise.all(
      Array.from({ length: callCount }, () => prepareInvoice(pool, undefined, {
        organizationId,
        branchCode: 'SBY',
        salesOrderId: randomUUID(),
        lines: [{ productId: randomUUID(), uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
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
    const productA = randomUUID();
    const productB = randomUUID();
    const prepared = await prepareInvoice(pool, undefined, {
      organizationId: randomUUID(),
      branchCode: 'JKT',
      salesOrderId: randomUUID(),
      lines: [
        { productId: productA, uom: 'CTN', qty: '10.000', unitPrice: '1000.00' },
        { productId: productB, uom: 'PCS', qty: '5.000', unitPrice: '2000.00' },
      ],
      ...auditContext(),
    });
    expect(prepared.total).toBe('20000.00');

    const issued = await issueInvoice(pool, undefined, {
      invoiceId: prepared.invoiceId,
      deliveredLines: [
        { productId: productA, uom: 'CTN', qtyDelivered: '10.000' },
        { productId: productB, uom: 'PCS', qtyDelivered: '5.000' },
      ],
      invoiceDate: '2026-09-27',
      ...auditContext(),
    });

    expect(issued).toMatchObject({ invoiceId: prepared.invoiceId, number: prepared.number, total: '20000.00', status: 'ISSUED' });

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

  it('recomputes totals to match delivered qty and removes a fully undelivered line on partial delivery', async () => {
    const productA = randomUUID();
    const productB = randomUUID();
    const prepared = await prepareInvoice(pool, undefined, {
      organizationId: randomUUID(),
      branchCode: 'JKT',
      salesOrderId: randomUUID(),
      lines: [
        { productId: productA, uom: 'CTN', qty: '10.000', unitPrice: '1000.00' },
        { productId: productB, uom: 'PCS', qty: '5.000', unitPrice: '2000.00' },
      ],
      ...auditContext(),
    });

    const issued = await issueInvoice(pool, undefined, {
      invoiceId: prepared.invoiceId,
      // Only product A is partially delivered (6 of 10); product B is entirely omitted.
      deliveredLines: [{ productId: productA, uom: 'CTN', qtyDelivered: '6.000' }],
      invoiceDate: '2026-09-27',
      ...auditContext(),
    });

    expect(issued.total).toBe('6000.00');

    const lines = await pool.query(
      `SELECT product_id, qty, line_total FROM sales.invoice_line WHERE invoice_id = $1`,
      [prepared.invoiceId],
    );
    expect(lines.rowCount).toBe(1);
    expect(lines.rows[0]).toMatchObject({ product_id: productA, qty: '6.000', line_total: '6000.00' });
  });

  it('throws INVALID_STATE_TRANSITION when the same invoice is issued twice', async () => {
    const productId = randomUUID();
    const prepared = await prepareInvoice(pool, undefined, {
      organizationId: randomUUID(),
      branchCode: 'JKT',
      salesOrderId: randomUUID(),
      lines: [{ productId, uom: 'CTN', qty: '1.000', unitPrice: '1000.00' }],
      ...auditContext(),
    });

    const issueOnce = () => issueInvoice(pool, undefined, {
      invoiceId: prepared.invoiceId,
      deliveredLines: [{ productId, uom: 'CTN', qtyDelivered: '1.000' }],
      invoiceDate: '2026-09-27',
      ...auditContext(),
    });

    await issueOnce();
    const secondAttempt = issueOnce();
    await expect(secondAttempt).rejects.toThrow(DomainError);
    await expect(secondAttempt).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});
