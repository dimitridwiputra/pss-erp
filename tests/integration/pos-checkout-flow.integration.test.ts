import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerPosTerminal, openPosShift, closePosShift, createPosSale, addPosSaleLine, checkoutPosSale, acceptPosTender, confirmPosPickupHandover, declarePosCashHandover } from '../../domains/pos/src/index';
import { parseEventForPublication } from '../../packages/contracts/src/events';
import { verifyCashCustody } from '../../domains/payments/src/index';
import { getOrCreateWalkInCustomer } from '../../domains/master-data/src/index';
import { applyAuditMigrations, applyMigrations } from '../../scripts/apply-migrations.mjs';

const databaseName = `pss_pos_e2e_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

const organizationId = randomUUID();
const branchId = randomUUID();
const warehouseId = randomUUID();
const cashierId = randomUUID();
const productId = randomUUID();
const barcode = `BC-${randomUUID().slice(0, 8)}`;
const meta = (userId: string) => ({ actor: { userId, roles: ['POS_CASHIER'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API' as const });

async function outboxFor(aggregateId: string) {
  const result = await pool.query<{ event_type: string; envelope: unknown }>(
    'SELECT event_type, envelope FROM platform.outbox_event WHERE aggregate_id = $1 ORDER BY created_at', [aggregateId],
  );
  return result.rows;
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString(), max: 20 });

  await applyAuditMigrations(pool);
  // Each domain's full ordered list, not one file per domain: a hardcoded `0001` silently stops
  // replaying the domain's later migrations (inventory 0002 was already missing here). `tax` is a
  // real precondition: checkout resolves PPN through it, and tax resolution reads platform config.
  for (const domain of ['platform', 'master-data', 'tax', 'commercial', 'inventory', 'orders', 'fulfillment', 'invoicing', 'payments', 'pos']) {
    await applyMigrations(pool, domain);
  }

  // Seed a sellable product with a karton barcode, an ACTIVE price list (POS-003 preconditions), and
  // a tax code. The code is `EXEMPT` deliberately: this test is about the counter-sales flow, and a
  // VAT_OUTPUT product would make it depend on an approved rate and a rounding rule being configured,
  // which would turn a POS regression into a tax-configuration failure.
  await pool.query(
    `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status, tax_code)
     VALUES ($1, $2, 'SKU-001', 'Indomie Goreng', 'PCS', 'PSS', 'ACTIVE', 'EXEMPT')`,
    [productId, organizationId],
  );
  await pool.query(
    `INSERT INTO core.tax_code (id, code, name, zero_rated)
     VALUES ($1, 'EXEMPT', 'Bebas PPN', true)
     ON CONFLICT (code) DO UPDATE SET zero_rated = EXCLUDED.zero_rated`,
    [randomUUID()],
  );

  // POS-004 defaults to the branch's walk-in customer when none is selected. Its treatment has to be
  // recorded before checkout: `tax` refuses a customer with an undetermined treatment rather than
  // assuming one, so an UNSET walk-in customer would fail the very checkout this test walks.
  const walkIn = await getOrCreateWalkInCustomer(pool, { organizationId, branchId });
  await pool.query(`UPDATE core.customer SET tax_treatment = 'EXEMPT' WHERE id = $1`, [walkIn.id]);
  await pool.query(
    `INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base)
     VALUES ($1, $2, 'KARTON', 40, false)`,
    [randomUUID(), productId],
  );
  await pool.query(
    `INSERT INTO core.product_barcode (id, product_id, uom, barcode) VALUES ($1, $2, 'KARTON', $3)`,
    [randomUUID(), productId, barcode],
  );
  const priceListId = randomUUID();
  await pool.query(
    `INSERT INTO core.price_list (id, organization_id, scope, status, valid_from) VALUES ($1, $2, 'KONTER', 'ACTIVE', '2027-01-01')`,
    [priceListId, organizationId],
  );
  await pool.query(
    `INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price) VALUES ($1, $2, $3, 'KARTON', '118000.00')`,
    [randomUUID(), priceListId, productId],
  );
  // Seed enough stock for a FULL reservation at checkout (POS-005.BR02).
  await pool.query(
    `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved)
     VALUES ($1, $2, $3, $4, 'KARTON', 25, 0)`,
    [randomUUID(), organizationId, warehouseId, productId],
  );
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('W-14 PSS Kasir counter sale (cash, full happy path)', () => {
  it('walks Buka Shift → keranjang → Bayar → Terima Uang → serah barang → serah kas → verifikasi', async () => {
    const terminal = await registerPosTerminal(pool, undefined, {
      organizationId, branchId, warehouseId, code: 'KSR-01', name: 'Konter 1', ...meta(cashierId),
    });
    expect(terminal.status).toBe('ACTIVE');

    const shift = await openPosShift(pool, undefined, {
      organizationId, terminalId: terminal.id, cashierUserId: cashierId, openingFloat: '500000.00', ...meta(cashierId),
    });
    expect(shift.status).toBe('OPEN');

    const sale = await createPosSale(pool, undefined, { shiftId: shift.id, ...meta(cashierId) });
    expect(sale.status).toBe('CART');

    const first = await addPosSaleLine(pool, undefined, {
      saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '1', ...meta(cashierId),
    });
    // Scanning the same karton again raises that line: one line per product reaches checkout, whose
    // stock reservation is one per sale and product (the demo-path e2e found two lines crashing it).
    const line = await addPosSaleLine(pool, undefined, {
      saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '1', ...meta(cashierId),
    });
    expect(line.id).toBe(first.id);
    expect(line.qty).toBe('2.000');
    expect(line.lineTotal).toBe('236000.00'); // 2 karton x Rp118.000
    const lineCount = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM pos.pos_sale_line WHERE sale_id = $1', [sale.id]);
    expect(lineCount.rows[0]!.count).toBe(1);

    const checkedOut = await checkoutPosSale(pool, undefined, { saleId: sale.id, ...meta(cashierId) });
    expect(checkedOut.status).toBe('PENDING_PAYMENT');
    expect(checkedOut.total).toBe('236000.00');
    expect(checkedOut.invoiceNumber).toMatch(/^INV-/);

    // Checking out twice (idempotency.R02) must not create a second SalesOrder or reserve stock again.
    await expect(checkoutPosSale(pool, undefined, { saleId: sale.id, ...meta(cashierId) }))
      .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    // Float money is compared in Postgres: 235999.99 is refused, not rounded up.
    await expect(acceptPosTender(pool, undefined, {
      saleId: sale.id, method: 'TUNAI', cashReceived: '235999.99', acceptedBy: cashierId, ...meta(cashierId),
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const tender = await acceptPosTender(pool, undefined, {
      saleId: sale.id, method: 'TUNAI', cashReceived: '250000.00', acceptedBy: cashierId, ...meta(cashierId),
    });
    expect(tender.saleStatus).toBe('PAID');
    expect(tender.changeAmount).toBe('14000.00');

    // SOD-09: the cashier who took the money cannot also hand over the goods.
    await expect(confirmPosPickupHandover(pool, undefined, {
      saleId: sale.id, actorId: cashierId, receiverName: 'Budi Santoso', ...meta(cashierId),
    })).rejects.toMatchObject({ code: 'SEGREGATION_OF_DUTIES' });

    const warehouseStaffId = randomUUID();
    const handedOver = await confirmPosPickupHandover(pool, undefined, {
      saleId: sale.id, actorId: warehouseStaffId, receiverName: 'Budi Santoso', ...meta(warehouseStaffId),
    });
    expect(handedOver.status).toBe('HANDED_OVER');

    const closed = await closePosShift(pool, undefined, {
      shiftId: shift.id, countedCash: '736000.00' /* 500000 float + 236000 sale */, ...meta(cashierId),
    });
    expect(closed.status).toBe('CLOSED');

    const handover = await declarePosCashHandover(pool, undefined, { shiftId: shift.id, ...meta(cashierId) });
    expect(handover.declaredAmount).toBe('236000.00'); // excludes the opening float, POS-014.BR01

    const financeCashierId = randomUUID();
    const verified = await verifyCashCustody(pool, undefined, {
      cashCustodyRecordId: handover.cashCustodyRecordId, countedAmount: '236000.00', verifiedBy: financeCashierId,
    });
    expect(verified.status).toBe('VERIFIED');

    // MVP_PLAN §5: each fact published once, in the same transaction, and valid for publication.
    const payment = await pool.query<{ id: string }>('SELECT id FROM payments.payment WHERE reference_id = $1', [sale.id]);
    const invoice = await pool.query<{ id: string }>('SELECT id FROM sales.invoice WHERE number = $1', [checkedOut.invoiceNumber]);
    const events = [
      ...(await outboxFor(payment.rows[0]!.id)),
      ...(await outboxFor(invoice.rows[0]!.id)),
      ...(await outboxFor(handover.cashCustodyRecordId)),
    ];
    expect(events.map((event) => event.event_type)).toEqual(['PAYMENT_RECEIVED', 'INVOICE_ISSUED', 'CASH_CUSTODY_VERIFIED']);
    for (const event of events) expect(() => parseEventForPublication(event.envelope)).not.toThrow();
    const [paymentEvent, invoiceEvent, custodyEvent] = events.map((event) => (event.envelope as { payload: Record<string, unknown> }).payload);
    expect(paymentEvent).toMatchObject({ amount: '236000.00', cashLocationType: 'POS_SHIFT', cashLocationId: shift.id, receivedBy: cashierId, referenceId: sale.id });
    expect(invoiceEvent).toMatchObject({ invoiceNumber: checkedOut.invoiceNumber, channel: 'POS', subtotal: '236000.00', taxAmount: '0.00', total: '236000.00', branchId });
    expect(custodyEvent).toMatchObject({ declaredAmount: '236000.00', countedAmount: '236000.00', varianceAmount: '0.00', sourceId: shift.id, verifiedBy: financeCashierId });

    const finalSale = await pool.query('SELECT status FROM pos.pos_sale WHERE id = $1', [sale.id]);
    expect(finalSale.rows[0].status).toBe('HANDED_OVER');
    const finalPayment = await pool.query("SELECT status FROM payments.payment WHERE reference_id = $1", [sale.id]);
    expect(finalPayment.rows[0].status).toBe('VERIFIED');
    const finalInvoice = await pool.query('SELECT status, total FROM sales.invoice WHERE number = $1', [checkedOut.invoiceNumber]);
    expect(finalInvoice.rows[0].status).toBe('ISSUED');
    expect(finalInvoice.rows[0].total).toBe('236000.00');
    const finalStock = await pool.query('SELECT qty_on_hand, qty_reserved FROM inventory.stock_balance WHERE warehouse_id = $1 AND product_id = $2', [warehouseId, productId]);
    expect(finalStock.rows[0].qty_on_hand).toBe('23.000'); // 25 - 2 karton issued
    expect(finalStock.rows[0].qty_reserved).toBe('0.000');
  });

  it('refuses a cart holding one product on two lines at different prices, before reserving anything', async () => {
    const cashier = randomUUID();
    const terminal = await registerPosTerminal(pool, undefined, { organizationId, branchId, warehouseId, code: 'KSR-03', name: 'Konter 3', ...meta(cashier) });
    const shift = await openPosShift(pool, undefined, { organizationId, terminalId: terminal.id, cashierUserId: cashier, openingFloat: '0', ...meta(cashier) });
    const sale = await createPosSale(pool, undefined, { shiftId: shift.id, ...meta(cashier) });
    await addPosSaleLine(pool, undefined, { saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '1', ...meta(cashier) });
    // A price that changed between two scans leaves a second line for the same product.
    await pool.query('UPDATE pos.pos_sale_line SET unit_price = 1 WHERE sale_id = $1', [sale.id]);
    await addPosSaleLine(pool, undefined, { saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '1', ...meta(cashier) });
    await expect(checkoutPosSale(pool, undefined, { saleId: sale.id, ...meta(cashier) })).rejects.toMatchObject({ code: 'REPRICE_REQUIRED' });
    const reserved = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM inventory.stock_reservation WHERE reference_id = $1", [sale.id]);
    expect(reserved.rows[0]!.count).toBe(0);
  });

  it('rejects checkout when stock is insufficient and leaves the sale in CART', async () => {
    const secondCashierId = randomUUID();
    const terminal = await registerPosTerminal(pool, undefined, {
      organizationId, branchId, warehouseId, code: 'KSR-02', name: 'Konter 2', ...meta(secondCashierId),
    });
    const shift = await openPosShift(pool, undefined, {
      organizationId, terminalId: terminal.id, cashierUserId: secondCashierId, openingFloat: '200000.00', ...meta(secondCashierId),
    });
    const sale = await createPosSale(pool, undefined, { shiftId: shift.id, ...meta(secondCashierId) });
    await addPosSaleLine(pool, undefined, { saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '999', ...meta(secondCashierId) });

    await expect(checkoutPosSale(pool, undefined, { saleId: sale.id, ...meta(secondCashierId) }))
      .rejects.toMatchObject({ code: 'POS_STOCK_INSUFFICIENT' });

    const stillCart = await pool.query('SELECT status FROM pos.pos_sale WHERE id = $1', [sale.id]);
    expect(stillCart.rows[0].status).toBe('CART');
    const noOrder = await pool.query('SELECT count(*)::int AS count FROM sales.sales_order WHERE client_key = $1', [sale.id]);
    expect(noOrder.rows[0].count).toBe(0);
  });
});
