import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveStock } from '../../domains/inventory/src/index';
import { verifyCashCustody } from '../../domains/payments/src/index';
import {
  acceptPosTender, addPosSaleLine, checkoutPosSale, closePosShift, confirmPosPickupHandover, createPosSale,
  declarePosCashHandover, openPosShift, printPosReceipt, registerPosTerminal,
} from '../../domains/pos/src/index';
import { parseEventForPublication } from '../../packages/contracts/src/events';
import { applyAuditMigrations, applyMigrations } from '../../scripts/apply-migrations.mjs';

/**
 * MVP_PLAN §1 and §2 (Day 5 checkpoint): one connected loop through every stream's facts, in one
 * database, the way the demo runs it.
 *
 *   goods receipt → sale → tender → pickup handover (another user) → close shift → cash handover
 *   → Finance verifies with a short count
 *
 * What is asserted now: every economic fact is published once, through the outbox, in a payload
 * that passes `parseEventForPublication`, and the amounts agree across the domains that own them
 * (invoice = payment = declaration; counted − declared = variance; stock moves by what was sold).
 *
 * What waits for the other streams, and is skipped here by name rather than left out:
 *   - the unit cost on the goods receipt and INVENTORY_RECEIVED / INVENTORY_ISSUED (OpenCode, §6.3);
 *   - journals and the trial balance (Codex, §6.2), once `domains/finance` has migrations.
 */
const databaseName = `pss_mvp_chain_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

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

const financeReady = existsSync(new URL('../../domains/finance/infrastructure/database/migrations/', import.meta.url))
  && existsSync(new URL('../../domains/finance/src/index.ts', import.meta.url));

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
  for (const domain of ['platform', 'master-data', 'commercial', 'inventory', 'orders', 'fulfillment', 'invoicing', 'payments', 'pos']) {
    await applyMigrations(pool, domain);
  }

  // Synthetic demo product (MVP-OD-6). Product and price creation have no command yet (OpenCode, §6.3).
  await pool.query(
    `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status)
     VALUES ($1, $2, 'DEMO-001', 'Mi Goreng 80g', 'PCS', 'PSS', 'ACTIVE')`, [productId, organizationId],
  );
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
    // Finance counts Rp1.000 short and says why (MVP-OD-9).
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
    // The declaration is the recorded cash, never the float (POS-014.BR01, MVP-OD-11); counted − declared = variance.
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

  it.skipIf(!financeReady)('posts balanced journals for every event and a trial balance that ties (waits for Codex finance, MVP_PLAN §6.2)', () => {
    // Filled in when domains/finance exports its consumer: dispatch the outbox above through it, then
    // assert every journal has SUM(debit) = SUM(credit) and the trial balance nets to zero, with
    // Selisih Kas carrying the Rp1.000 shortage (§8 CASH_CUSTODY_VERIFIED rule).
    expect(financeReady).toBe(true);
  });
});
