import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerPosTerminal, openPosShift, createPosSale, addPosSaleLine, checkoutPosSale, acceptPosTender, confirmPosPickupHandover, declarePosCashHandover } from '../../domains/pos/src/index';
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
  // Whole domains by name, so a migration added later is picked up without editing this fixture:
  // a fixture that replays only `0001` is what made amending a shipped migration look safe
  // (MIG-RISK-AUD-001). `platform` is fully replayed rather than only its first two files because
  // tax resolution reads `platform.config_value`, and `tax` and `invoicing` are applied in full
  // because checkout now resolves PPN through them — a real precondition of this flow.
  await applyMigrations(pool, 'platform');
  await applyMigrations(pool, 'master-data');
  await applyMigrations(pool, 'tax');
  await applyMigrations(pool, 'commercial');
  await applyMigrations(pool, 'inventory');
  await applyMigrations(pool, 'orders');
  await applyMigrations(pool, 'fulfillment');
  await applyMigrations(pool, 'invoicing');
  await applyMigrations(pool, 'payments');
  await applyMigrations(pool, 'pos');

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
    const terminal = await registerPosTerminal(pool, {
      organizationId, branchId, warehouseId, code: 'KSR-01', name: 'Konter 1',
      actor: { userId: cashierId, roles: ['POS_CASHIER'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    expect(terminal.status).toBe('ACTIVE');

    const shift = await openPosShift(pool, {
      organizationId, terminalId: terminal.id, cashierUserId: cashierId, openingFloat: '500000.00',
      actor: { userId: cashierId, roles: ['POS_CASHIER'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    expect(shift.status).toBe('OPEN');

    const sale = await createPosSale(pool, { organizationId, terminalId: terminal.id, shiftId: shift.id });
    expect(sale.status).toBe('CART');

    const line = await addPosSaleLine(pool, {
      organizationId, saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '2',
    });
    expect(line.lineTotal).toBe('236000.00'); // 2 karton x Rp118.000

    const checkedOut = await checkoutPosSale(pool, {
      saleId: sale.id, actor: { userId: cashierId, roles: ['POS_CASHIER'] },
      requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    expect(checkedOut.status).toBe('PENDING_PAYMENT');
    expect(checkedOut.total).toBe('236000.00');
    expect(checkedOut.invoiceNumber).toMatch(/^INV-/);

    // Checking out twice (idempotency.R02) must not create a second SalesOrder or reserve stock again.
    await expect(checkoutPosSale(pool, {
      saleId: sale.id, actor: { userId: cashierId, roles: ['POS_CASHIER'] },
      requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    })).rejects.toThrow();

    const tender = await acceptPosTender(pool, {
      saleId: sale.id, method: 'TUNAI', cashReceived: '250000.00', acceptedBy: cashierId,
      requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    expect(tender.saleStatus).toBe('PAID');
    expect(tender.changeAmount).toBe('14000.00');

    const handedOver = await confirmPosPickupHandover(pool, {
      saleId: sale.id, actorId: randomUUID() /* warehouse staff, distinct from the cashier */, receiverName: 'Budi Santoso',
      sodCashierNotHandoverEnabled: true, businessDate: '2027-01-15',
      actor: { userId: cashierId, roles: [] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    expect(handedOver.status).toBe('HANDED_OVER');

    const closed = await import('../../domains/pos/src/application/pos-shift').then((mod) => mod.closePosShift(pool, {
      shiftId: shift.id, countedCash: '736000.00' /* 500000 float + 236000 sale */,
      actor: { userId: cashierId, roles: [] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    }));
    expect(closed.status).toBe('CLOSED');

    const handover = await declarePosCashHandover(pool, { shiftId: shift.id });
    expect(handover.declaredAmount).toBe('236000.00'); // excludes the opening float, POS-014.BR01

    const financeCashierId = randomUUID();
    const verified = await verifyCashCustody(pool, {
      cashCustodyRecordId: handover.cashCustodyRecordId, countedAmount: '236000.00', verifiedBy: financeCashierId,
    });
    expect(verified.status).toBe('VERIFIED');

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

  it('rejects checkout when stock is insufficient and leaves the sale in CART', async () => {
    const terminal = await registerPosTerminal(pool, {
      organizationId, branchId, warehouseId, code: 'KSR-02', name: 'Konter 2',
      actor: { userId: cashierId, roles: ['POS_CASHIER'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    const shift = await openPosShift(pool, {
      organizationId, terminalId: terminal.id, cashierUserId: randomUUID(), openingFloat: '200000.00',
      actor: { roles: [], serviceIdentity: 'test' }, requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    });
    const sale = await createPosSale(pool, { organizationId, terminalId: terminal.id, shiftId: shift.id });
    await addPosSaleLine(pool, { organizationId, saleId: sale.id, priceListScope: 'KONTER', barcode, qty: '999' });

    await expect(checkoutPosSale(pool, {
      saleId: sale.id, actor: { userId: randomUUID(), roles: [] },
      requestId: randomUUID(), correlationId: randomUUID(), source: 'API',
    })).rejects.toThrow();

    const stillCart = await pool.query('SELECT status FROM pos.pos_sale WHERE id = $1', [sale.id]);
    expect(stillCart.rows[0].status).toBe('CART');
    const noOrder = await pool.query('SELECT count(*)::int AS count FROM sales.sales_order WHERE client_key = $1', [sale.id]);
    expect(noOrder.rows[0].count).toBe(0);
  });
});
