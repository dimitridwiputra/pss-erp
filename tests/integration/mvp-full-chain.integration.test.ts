import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveStock } from '../../domains/inventory/src/index';
import { getOrCreateWalkInCustomer, setCustomerTaxTreatment } from '../../domains/master-data/src/index';
import { verifyCashCustody } from '../../domains/payments/src/index';
import {
  acceptPosTender, addPosSaleLine, checkoutPosSale, closePosShift, confirmPosPickupHandover, createPosSale,
  declarePosCashHandover, openPosShift, printPosReceipt, registerPosTerminal,
} from '../../domains/pos/src/index';
import { parseEventForPublication } from '../../packages/contracts/src/events';
import { consumeEconomicEvent, demoPostingRules, ECONOMIC_EVENT_TYPES, trialBalance } from '../../domains/finance/src/index';
import { applyAuditMigrations, applyMigrations } from '../../scripts/apply-migrations.mjs';

/**
 * MVP_PLAN §1 and §2 (Day 5 checkpoint): one connected loop through every stream's facts, in one
 * database, the way the demo runs it.
 *
 *   goods receipt → sale → tender → pickup handover (another user) → close shift → cash handover
 *   → Finance verifies with a short count
 *
 * What is asserted: every economic fact is published once, through the outbox, in a payload
 * that passes `parseEventForPublication`; the amounts agree across the domains that own them
 * (invoice = payment = declaration; counted − declared = variance; stock moves by what was sold);
 * and Finance posts each of them once into balanced journals and a trial balance that ties.
 */
const databaseName = `pss_mvp_chain_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;
let walkInCustomerId = '';

const organizationId = randomUUID();
const branchId = randomUUID();
const warehouseId = randomUUID();
const productId = randomUUID();
const cashierId = randomUUID();
const warehouseStaffId = randomUUID();
const financeCashierId = randomUUID();
const barcode = `BC-${randomUUID().slice(0, 8)}`;
const correlationId = `chain-${randomUUID()}`;
const meta = (userId: string) => ({ actor: { userId, roles: [] }, requestId: randomUUID(), correlationId, source: 'API' as const });

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString(), max: 10 });

  await applyAuditMigrations(pool);
  for (const domain of ['platform', 'master-data', 'tax', 'commercial', 'inventory', 'orders', 'fulfillment', 'invoicing', 'payments', 'pos', 'finance']) {
    await applyMigrations(pool, domain);
  }

  for (const [code, name, type, normal] of [
    ['1-1100', 'Kas Kantor', 'ASSET', 'DEBIT'], ['1-1110', 'Kas Konter', 'ASSET', 'DEBIT'],
    ['1-1300', 'Piutang Usaha', 'ASSET', 'DEBIT'], ['1-1400', 'Persediaan', 'ASSET', 'DEBIT'],
    ['2-1150', 'Barang Diterima Belum Ditagih', 'LIABILITY', 'CREDIT'],
    ['2-1300', 'PPN Keluaran', 'LIABILITY', 'CREDIT'], ['4-1000', 'Penjualan', 'REVENUE', 'CREDIT'],
    ['5-1000', 'Harga Pokok Penjualan', 'EXPENSE', 'DEBIT'],
    ['6-2100', 'Selisih Persediaan', 'EXPENSE', 'DEBIT'], ['6-2200', 'Selisih Kas', 'EXPENSE', 'DEBIT'],
  ]) {
    await pool.query('INSERT INTO finance.account (code, name, type, normal_balance) VALUES ($1,$2,$3,$4)',
      [code, name, type, normal]);
  }
  for (const rule of demoPostingRules) {
    await pool.query(`INSERT INTO finance.posting_rule (event_type, version, effective_from, line_template)
      VALUES ($1,$2,'2026-01-01',$3::jsonb)`, [rule.eventType, rule.version, JSON.stringify(rule.template)]);
  }

  // Synthetic demo product (MVP-OD-6), taxable like every demo product: the customer's PPN switch
  // decides whether a sale carries PPN.
  await pool.query(
    `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status, tax_code)
     VALUES ($1, $2, 'DEMO-001', 'Mi Goreng 80g', 'PCS', 'PSS', 'ACTIVE', 'VAT_OUTPUT')`, [productId, organizationId],
  );
  // PPN configured as the demo seed configures it, and the walk-in customer starting with PPN off, so
  // the loop's amounts are the runbook's. The last describe switches it on.
  await pool.query(
    `INSERT INTO platform.config_value (id, key, organization_id, value, valid_from, status, proposed_by, approved_by, revision, reason_code)
     VALUES ($1, 'tax.vat_output_rate', $3, '"11"'::jsonb, DATE '2026-01-01', 'ACTIVE', $4, $4, 1, 'fixture'),
            ($2, 'tax.rounding_rule', $3, '"HALF_UP"'::jsonb, DATE '2026-01-01', 'ACTIVE', $4, $4, 1, 'fixture')`,
    [randomUUID(), randomUUID(), organizationId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO core.tax_rate (id, organization_id, tax_code_id, rate, valid_from, status, approval_id)
     SELECT $1, $2, id, 11, DATE '2026-01-01', 'ACTIVE', $3 FROM core.tax_code WHERE code = 'VAT_OUTPUT'`,
    [randomUUID(), organizationId, randomUUID()],
  );
  walkInCustomerId = (await getOrCreateWalkInCustomer(pool, { organizationId, branchId })).id;
  await setCustomerTaxTreatment(pool, undefined, {
    organizationId, customerId: walkInCustomerId, taxTreatment: 'NON_VAT', ...meta(financeCashierId),
  });
  await pool.query(`INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base) VALUES ($1, $2, 'KARTON', 40, false)`, [randomUUID(), productId]);
  await pool.query(`INSERT INTO core.product_barcode (id, product_id, uom, barcode) VALUES ($1, $2, 'KARTON', $3)`, [randomUUID(), productId, barcode]);
  const priceListId = randomUUID();
  await pool.query(`INSERT INTO core.price_list (id, organization_id, scope, status, valid_from) VALUES ($1, $2, 'KONTER', 'ACTIVE', '2026-01-01')`, [priceListId, organizationId]);
  await pool.query(`INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price) VALUES ($1, $2, $3, 'KARTON', '118000.00')`, [randomUUID(), priceListId, productId]);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

async function published() {
  const rows = await pool.query<{ event_type: string; aggregate_id: string; envelope: { correlationId: string; payload: Record<string, unknown> } }>(
    'SELECT event_type, aggregate_id, envelope FROM platform.outbox_event ORDER BY created_at, event_id',
  );
  return rows.rows;
}

describe('MVP full chain: receipt → sale → handover → close → verify', () => {
  let custodyId = '';
  let invoiceNumber = '';

  it('runs the loop and publishes each fact once, valid, and correlated', async () => {
    // Goods receipt, costed: the stock quantity is what the sale needs, and the unit cost is what
    // gives the sale a cost of goods sold. MVP-OD-4 moving average, so the balance now holds a value.
    await receiveStock(pool, undefined, {
      organizationId, warehouseId, referenceType: 'GOODS_RECEIPT', referenceId: randomUUID(),
      sourceType: 'GOODS_RECEIPT',
      lines: [{ productId, uom: 'KARTON', qty: '10', unitCost: '95000' }], ...meta(warehouseStaffId),
    });

    const terminal = await registerPosTerminal(pool, undefined, { organizationId, branchId, warehouseId, code: 'KSR-01', name: 'Konter 1', ...meta(cashierId) });
    const shift = await openPosShift(pool, undefined, { organizationId, terminalId: terminal.id, cashierUserId: cashierId, openingFloat: '500000.00', ...meta(cashierId) });
    const sale = await createPosSale(pool, undefined, { shiftId: shift.id, ...meta(cashierId) });
    await addPosSaleLine(pool, undefined, { saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '2', ...meta(cashierId) });
    const checkedOut = await checkoutPosSale(pool, undefined, { saleId: sale.id, ...meta(cashierId) });
    invoiceNumber = checkedOut.invoiceNumber;
    await acceptPosTender(pool, undefined, { saleId: sale.id, method: 'TUNAI', cashReceived: '250000.00', acceptedBy: cashierId, ...meta(cashierId) });
    await printPosReceipt(pool, undefined, { saleId: sale.id, printedBy: cashierId, ...meta(cashierId) });
    await confirmPosPickupHandover(pool, undefined, { saleId: sale.id, actorId: warehouseStaffId, receiverName: 'Budi Santoso', ...meta(warehouseStaffId) });
    await closePosShift(pool, undefined, { shiftId: shift.id, countedCash: '736000.00', ...meta(cashierId) });
    const handover = await declarePosCashHandover(pool, undefined, { shiftId: shift.id, ...meta(cashierId) });
    custodyId = handover.cashCustodyRecordId;
    // Finance counts Rp1.000 short and says why (MVP-OD-26).
    await verifyCashCustody(pool, undefined, {
      cashCustodyRecordId: custodyId, countedAmount: '235000.00', verifiedBy: financeCashierId, reasonCode: 'RC-CSH-COUNT_SHORT',
      requestId: randomUUID(), correlationId,
    });

    const events = await published();
    // The order is the demo's, not a convenient one: the receipt values the stock, the cashier takes
    // the payment at the counter, and only then does warehouse staff hand the goods over — which is
    // what values what left the stock and issues the invoice. Payment before issue is why Piutang
    // Usaha carries a temporary credit balance between the two (MVP_PLAN §8).
    const economic = events.filter((event) => [
      'INVENTORY_RECEIVED', 'INVENTORY_ISSUED', 'PAYMENT_RECEIVED', 'INVOICE_ISSUED', 'CASH_CUSTODY_VERIFIED',
    ].includes(event.event_type));
    expect(economic.map((event) => event.event_type)).toEqual([
      'INVENTORY_RECEIVED', 'PAYMENT_RECEIVED', 'INVENTORY_ISSUED', 'INVOICE_ISSUED', 'CASH_CUSTODY_VERIFIED',
    ]);
    expect(events.map((event) => event.event_type)).toContain('DELIVERY_ORDER_DELIVERED');
    for (const event of events) {
      expect(() => parseEventForPublication(event.envelope)).not.toThrow();
      expect(event.envelope.correlationId).toBe(correlationId);
    }
  });

  it('agrees on the amounts across the domains that own them', async () => {
    const byType = Object.fromEntries((await published()).map((event) => [event.event_type, event.envelope.payload]));
    const invoice = byType.INVOICE_ISSUED!;
    const payment = byType.PAYMENT_RECEIVED!;
    const custody = byType.CASH_CUSTODY_VERIFIED!;
    expect(invoice).toMatchObject({ invoiceNumber, subtotal: '236000.00', taxAmount: '0.00', total: '236000.00', channel: 'POS' });
    // Payment is posted before the invoice at the counter (§8): same amount, same customer, same invoice.
    expect(payment).toMatchObject({ amount: invoice.total, customerId: invoice.customerId, invoiceId: invoice.invoiceId });
    // The declaration is the recorded cash, never the float (POS-014.BR01, MVP-OD-29); counted − declared = variance.
    expect(custody).toMatchObject({ declaredAmount: payment.amount, countedAmount: '235000.00', varianceAmount: '-1000.00', sourceId: payment.cashLocationId });

    const stock = await pool.query<{ qty_on_hand: string; qty_reserved: string; avg_unit_cost: string }>(
      `SELECT qty_on_hand::text, qty_reserved::text, avg_unit_cost::text
       FROM inventory.stock_balance WHERE warehouse_id = $1 AND product_id = $2`, [warehouseId, productId],
    );
    // 10 received less 2 handed over, still valued at the receipt's cost: an issue does not re-average.
    expect(stock.rows[0]).toEqual({ qty_on_hand: '8.000', qty_reserved: '0.000', avg_unit_cost: '95000.0000' });
  });

  it('values the goods receipt and publishes INVENTORY_RECEIVED / INVENTORY_ISSUED with a cost', async () => {
    const byType = Object.fromEntries((await published()).map((event) => [event.event_type, event.envelope.payload]));

    // 10 KARTON at Rp 95.000: the receipt is worth Rp 950.000 and the balance averages to its cost.
    expect(byType.INVENTORY_RECEIVED).toMatchObject({
      // `unitCost` carries the ledger's 4 places since MVP-OD-13; `totalCost` stays 2-place money.
      productId, uom: 'KARTON', qty: '10.000', unitCost: '95000.0000', totalCost: '950000.00',
      sourceType: 'GOODS_RECEIPT',
    });

    // The handover of 2 KARTON is what gives the sale a cost of goods sold: Rp 190.000 against the
    // invoice's Rp 236.000, so the demo's gross profit is a real number rather than revenue alone.
    expect(byType.INVENTORY_ISSUED).toMatchObject({
      productId, uom: 'KARTON', qty: '2.000', unitCost: '95000.0000', totalCost: '190000.00',
      sourceType: 'SALES_FULFILLMENT',
    });

    const grossProfit = 236000 - 190000;
    expect(grossProfit).toBe(46000);
  });

  it('retries publish nothing twice', async () => {
    const before = (await published()).length;
    await expect(verifyCashCustody(pool, undefined, { cashCustodyRecordId: custodyId, countedAmount: '235000.00', verifiedBy: financeCashierId }))
      .rejects.toMatchObject({ code: 'CUSTODY_ALREADY_VERIFIED' });
    expect((await published()).length).toBe(before);
  });

  it('posts each valued economic event once, balances every journal and ties the trial balance', async () => {
    const events = (await published()).filter((event) =>
      ECONOMIC_EVENT_TYPES.some((type) => type === event.event_type));
    expect(events.map((event) => event.event_type)).toEqual([
      'INVENTORY_RECEIVED', 'PAYMENT_RECEIVED', 'INVENTORY_ISSUED', 'INVOICE_ISSUED', 'CASH_CUSTODY_VERIFIED',
    ]);
    const periods = [...new Set(events.map((event) =>
      (event.envelope as { businessDate: string }).businessDate.slice(0, 7)))];
    for (const code of periods) {
      await pool.query(`INSERT INTO finance.accounting_period (organization_id, code, status)
        VALUES ($1,$2,'OPEN') ON CONFLICT DO NOTHING`, [organizationId, code]);
    }
    for (const event of events) {
      expect(await consumeEconomicEvent(pool, event.envelope)).toMatchObject({
        status: 'PROCESSED', value: { status: 'POSTED' },
      });
      expect(await consumeEconomicEvent(pool, event.envelope)).toMatchObject({ status: 'DUPLICATE' });
    }
    const journals = (await pool.query<{ source_event_id: string; debit: string; credit: string }>(
      `SELECT j.source_event_id, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
       FROM finance.journal j JOIN finance.journal_line l ON l.journal_id = j.id
       WHERE j.organization_id = $1 AND j.status = 'POSTED'
       GROUP BY j.id, j.source_event_id`, [organizationId],
    )).rows;
    expect(journals).toHaveLength(events.length);
    for (const journal of journals) {
      expect(journal.debit).toBe(journal.credit);
      expect(journals.filter((entry) => entry.source_event_id === journal.source_event_id)).toHaveLength(1);
    }
    const shortage = (await pool.query<{ debit: string; credit: string }>(
      `SELECT l.debit::text AS debit, l.credit::text AS credit
       FROM finance.journal_line l JOIN finance.journal j ON j.id = l.journal_id
       WHERE j.organization_id = $1 AND j.source_type = 'CASH_CUSTODY_VERIFIED'
         AND l.account_code = '6-2200'`, [organizationId],
    )).rows;
    expect(shortage).toEqual([{ debit: '1000.00', credit: '0.00' }]);
    // The handover's cost of goods sold reaches the ledger: 2 KARTON at Rp 95.000.
    const costOfGoods = (await pool.query<{ debit: string }>(
      `SELECT l.debit::text AS debit FROM finance.journal_line l JOIN finance.journal j ON j.id = l.journal_id
       WHERE j.organization_id = $1 AND j.source_type = 'INVENTORY_ISSUED' AND l.account_code = '5-1000'`, [organizationId],
    )).rows;
    expect(costOfGoods).toEqual([{ debit: '190000.00' }]);
    const through = events.map((event) =>
      (event.envelope as { businessDate: string }).businessDate).sort().at(-1)!;
    const balance = await trialBalance(pool, organizationId, through);
    expect(balance).toMatchObject({ balanced: true });
    expect(balance.totalDebit).toBe(balance.totalCredit);
  });
});

describe('MVP full chain with PPN switched on for the walk-in customer', () => {
  it('charges PPN on the next sale, issues it on the invoice, and Finance posts it to PPN Keluaran', async () => {
    const before = (await published()).length;
    await setCustomerTaxTreatment(pool, undefined, {
      organizationId, customerId: walkInCustomerId, taxTreatment: 'VAT_OUTPUT', ...meta(financeCashierId),
    });

    const terminal = await registerPosTerminal(pool, undefined, { organizationId, branchId, warehouseId, code: 'KSR-02', name: 'Konter 2', ...meta(cashierId) });
    const shift = await openPosShift(pool, undefined, { organizationId, terminalId: terminal.id, cashierUserId: cashierId, openingFloat: '0.00', ...meta(cashierId) });
    const sale = await createPosSale(pool, undefined, { shiftId: shift.id, ...meta(cashierId) });
    await addPosSaleLine(pool, undefined, { saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '1', ...meta(cashierId) });
    const checkedOut = await checkoutPosSale(pool, undefined, { saleId: sale.id, ...meta(cashierId) });
    // Rp 118.000 + 11% = Rp 130.980: the amount due is the invoice's, PPN included.
    expect(checkedOut.total).toBe('130980.00');
    const stored = await pool.query<{ tax_total: string; total: string }>(
      'SELECT tax_total::text, total::text FROM pos.pos_sale WHERE id = $1', [sale.id],
    );
    expect(stored.rows[0]).toEqual({ tax_total: '12980.00', total: '130980.00' });

    await acceptPosTender(pool, undefined, { saleId: sale.id, method: 'TUNAI', cashReceived: '131000.00', acceptedBy: cashierId, ...meta(cashierId) });
    await confirmPosPickupHandover(pool, undefined, { saleId: sale.id, actorId: warehouseStaffId, receiverName: 'Budi Santoso', ...meta(warehouseStaffId) });

    const events = (await published()).slice(before);
    const invoice = events.find((event) => event.event_type === 'INVOICE_ISSUED')!;
    expect(invoice.envelope.payload).toMatchObject({ subtotal: '118000.00', taxAmount: '12980.00', total: '130980.00' });

    for (const event of events.filter((entry) => ECONOMIC_EVENT_TYPES.some((type) => type === entry.event_type))) {
      expect(await consumeEconomicEvent(pool, event.envelope)).toMatchObject({ status: 'PROCESSED' });
    }
    const outputVat = (await pool.query<{ credit: string }>(
      `SELECT l.credit::text AS credit FROM finance.journal_line l JOIN finance.journal j ON j.id = l.journal_id
       WHERE j.organization_id = $1 AND j.source_event_id = $2 AND l.account_code = '2-1300'`,
      [organizationId, (invoice.envelope as { eventId: string }).eventId],
    )).rows;
    expect(outputVat).toEqual([{ credit: '12980.00' }]);
    const through = events.map((event) => (event.envelope as { businessDate: string }).businessDate).sort().at(-1)!;
    expect(await trialBalance(pool, organizationId, through)).toMatchObject({ balanced: true });
  });
});
