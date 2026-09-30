import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import pg from 'pg';

/**
 * Local MVP demo data (docs/mvp/MVP_PLAN.md, MVP-OD-6: synthetic sample products). Safe to re-run:
 * every row has a fixed id or is guarded by a lookup, so a second run changes nothing.
 *
 * **Everything now goes through its owning domain's command** — `registerPosTerminal` (pos),
 * `createProduct`/`addProductUom`/`addProductBarcode` (master-data), `activatePriceList` (commercial)
 * and `receiveStock` (inventory). The earlier version inserted products, barcodes and prices with raw
 * SQL, which meant the demo data had never been through validation, an audit entry or an idempotency
 * key, and the opening stock posted no value to the General Ledger. The opening stock is now a
 * **costed goods receipt**, so it produces `INVENTORY_RECEIVED` and finance's Dr Persediaan /
 * Cr Barang Diterima Belum Ditagih, exactly as a real receipt would.
 *
 * The catalog is synthetic (MVP-OD-6). Prices, costs and pack sizes are demo placeholders, not PSS
 * data, and are not taken from any principal's price file.
 *
 * Needs `pnpm build` (loads each domain's dist), `pnpm db:migrate`, and the demo identity from
 * `pnpm idp:setup:local`.
 */
const require = createRequire(import.meta.url);
const { registerPosTerminal } = require('../domains/pos/dist/index.js');
const { createProduct, addProductUom, addProductBarcode } = require('../domains/master-data/dist/index.js');
const { activatePriceList } = require('../domains/commercial/dist/index.js');
const { receiveStock } = require('../domains/inventory/dist/index.js');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to seed the local demo.');

const demo = JSON.parse(await readFile(new URL('../infrastructure/keycloak/pss-demo-users.json', import.meta.url), 'utf8'));
const organizationId = demo.organization.id;
const branchId = demo.branch.id;
const warehouseId = demo.warehouse.id;

const terminals = [
  { id: '0199a000-0000-7000-8000-00000000d201', code: 'KSR-01', name: 'Konter 1' },
  { id: '0199a000-0000-7000-8000-00000000d202', code: 'KSR-02', name: 'Konter 2' },
];
const priceListId = '0199a000-0000-7000-8000-00000000d301';

/**
 * Twenty FMCG items across four categories, each with a base unit, a case unit, a barcode per unit,
 * a price and a cost, so the counter can scan either the piece or the case and the back office has a
 * catalog worth looking at.
 *
 * **The first four are the original demo products, unchanged** — same ids, SKUs, names, units, case
 * factors, barcodes, prices and 50 in stock — because DEMO_RUNBOOK §3, §4.2 and the demo-path test
 * all name them: `8990001000012` Mi Goreng KARTON Rp118.000 and `8990001000043` Saus Sambal BTL
 * Rp12.000, and the insufficient-stock path raises a Mi Goreng line to 999.
 *
 * `cost` is what makes the demo's gross profit real. The opening receipt posts it, so the shelf is
 * worth something on the first day and the first sale has a cost of goods sold to measure a margin
 * against. It is deliberately below `price`.
 *
 * Synthetic values (MVP-OD-6): generic Indonesian grocery names, placeholder barcodes, prices, costs
 * and pack sizes. None of it is taken from a principal's price file.
 */
const catalog = [
  { sku: 'DEMO-001', name: 'Mi Goreng 80g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 40], barcodes: [{ uom: 'KARTON', code: '8990001000012' }], price: '118000.00', cost: '95000.00', qty: '50' },
  { sku: 'DEMO-002', name: 'Air Mineral 600ml', category: 'MINUMAN', baseUom: 'BTL', case: ['KARTON', 24], barcodes: [{ uom: 'KARTON', code: '8990001000029' }], price: '48000.00', cost: '38000.00', qty: '50' },
  { sku: 'DEMO-003', name: 'Minuman Cokelat 200ml', category: 'MINUMAN', baseUom: 'PCS', case: ['KARTON', 36], barcodes: [{ uom: 'KARTON', code: '8990001000036' }], price: '126000.00', cost: '104000.00', qty: '50' },
  { sku: 'DEMO-004', name: 'Saus Sambal 340ml', category: 'BUMBU', baseUom: 'BTL', case: ['BTL', 1], barcodes: [{ uom: 'BTL', code: '8990001000043' }], price: '12000.00', cost: '8600.00', qty: '50' },
  { sku: 'DEMO-005', name: 'Mi Kuah Ayam Bawang 65g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 40], barcodes: [{ uom: 'PCS', code: '8990001000050' }, { uom: 'KARTON', code: '8990001100057' }], price: '112000.00', cost: '91000.00', qty: '40' },
  { sku: 'DEMO-006', name: 'Mi Goreng Ayam Special 85g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 30], barcodes: [{ uom: 'PCS', code: '8990001000067' }, { uom: 'KARTON', code: '8990001100064' }], price: '126000.00', cost: '103000.00', qty: '30' },
  { sku: 'DEMO-007', name: 'Mi Kuah Soto 85g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 30], barcodes: [{ uom: 'PCS', code: '8990001000074' }, { uom: 'KARTON', code: '8990001100071' }], price: '121000.00', cost: '99000.00', qty: '30' },
  { sku: 'DEMO-008', name: 'Mi Goreng Rendang 85g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 30], barcodes: [{ uom: 'PCS', code: '8990001000081' }, { uom: 'KARTON', code: '8990001100088' }], price: '124000.00', cost: '101000.00', qty: '30' },
  { sku: 'DEMO-009', name: 'Minuman Isotonik 500ml', category: 'MINUMAN', baseUom: 'BTL', case: ['KARTON', 24], barcodes: [{ uom: 'BTL', code: '8990001000088' }, { uom: 'KARTON', code: '8990001100095' }], price: '54000.00', cost: '43000.00', qty: '24' },
  { sku: 'DEMO-010', name: 'Susu UHT Full Cream 1L', category: 'MINUMAN', baseUom: 'PCS', case: ['KARTON', 12], barcodes: [{ uom: 'PCS', code: '8990001000095' }, { uom: 'KARTON', code: '8990001100101' }], price: '168000.00', cost: '142000.00', qty: '12' },
  { sku: 'DEMO-011', name: 'Teh Celup Melati 25s', category: 'MINUMAN', baseUom: 'BKS', case: ['KARTON', 12], barcodes: [{ uom: 'BKS', code: '8990001000101' }, { uom: 'KARTON', code: '8990001100108' }], price: '62000.00', cost: '49000.00', qty: '12' },
  { sku: 'DEMO-012', name: 'Air Mineral 1.5L', category: 'MINUMAN', baseUom: 'BTL', case: ['KARTON', 6], barcodes: [{ uom: 'BTL', code: '8990001000108' }, { uom: 'KARTON', code: '8990001100115' }], price: '34000.00', cost: '27000.00', qty: '6' },
  { sku: 'DEMO-013', name: 'Kecap Manis 520ml', category: 'BUMBU', baseUom: 'BTL', case: ['KARTON', 12], barcodes: [{ uom: 'BTL', code: '8990001000115' }, { uom: 'KARTON', code: '8990001100122' }], price: '23500.00', cost: '19000.00', qty: '12' },
  { sku: 'DEMO-014', name: 'Minyak Goreng 1L', category: 'BUMBU', baseUom: 'BTL', case: ['KARTON', 12], barcodes: [{ uom: 'BTL', code: '8990001000122' }, { uom: 'KARTON', code: '8990001100129' }], price: '178000.00', cost: '156000.00', qty: '12' },
  { sku: 'DEMO-015', name: 'Gula Pasir 1kg', category: 'BUMBU', baseUom: 'BKS', case: ['KARTON', 10], barcodes: [{ uom: 'BKS', code: '8990001000129' }, { uom: 'KARTON', code: '8990001100136' }], price: '152000.00', cost: '134000.00', qty: '10' },
  { sku: 'DEMO-016', name: 'Garam Halus 250g', category: 'BUMBU', baseUom: 'BKS', case: ['KARTON', 40], barcodes: [{ uom: 'BKS', code: '8990001000136' }, { uom: 'KARTON', code: '8990001100143' }], price: '18000.00', cost: '12000.00', qty: '40' },
  { sku: 'DEMO-017', name: 'Biskuit Kelapa 300g', category: 'SNACK', baseUom: 'BKS', case: ['KARTON', 24], barcodes: [{ uom: 'BKS', code: '8990001000143' }, { uom: 'KARTON', code: '8990001100150' }], price: '96000.00', cost: '78000.00', qty: '24' },
  { sku: 'DEMO-018', name: 'Keripik Kentang Ori 68g', category: 'SNACK', baseUom: 'PCS', case: ['KARTON', 36], barcodes: [{ uom: 'PCS', code: '8990001000150' }, { uom: 'KARTON', code: '8990001100167' }], price: '84000.00', cost: '67000.00', qty: '36' },
  { sku: 'DEMO-019', name: 'Kopi Bubuk Instan 20s', category: 'SNACK', baseUom: 'PCS', case: ['KARTON', 24], barcodes: [{ uom: 'PCS', code: '8990001000157' }, { uom: 'KARTON', code: '8990001100174' }], price: '108000.00', cost: '89000.00', qty: '24' },
  { sku: 'DEMO-020', name: 'Sabun Mandi Cair 825ml', category: 'KEBUTUHAN RUMAH', baseUom: 'BTL', case: ['KARTON', 12], barcodes: [{ uom: 'BTL', code: '8990001000164' }, { uom: 'KARTON', code: '8990001100181' }], price: '186000.00', cost: '158000.00', qty: '12' },
];

/** Display only: the amount is already a decimal string, and this never becomes a number. */
const rupiahOf = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
  .format(Number(value.split('.')[0]));

const pool = new pg.Pool({ connectionString: databaseUrl });
const meta = { actor: { roles: [], serviceIdentity: 'mvp-demo-seed' }, requestId: randomUUID(), correlationId: randomUUID(), source: 'SYSTEM' };

async function exists(sql, values) {
  const found = await pool.query(sql, values);
  return Boolean(found.rowCount);
}

try {
  // The demo's gross margin is the whole reason the opening stock is costed, and a missing costing
  // migration otherwise shows up as a raw SQL error from inside the receipt, on the rehearsal morning.
  // Checked first, before anything is written, so the failure names its cause.
  const costing = await pool.query(
    `SELECT count(*)::int AS present FROM information_schema.columns
     WHERE table_schema = 'inventory' AND table_name = 'stock_balance' AND column_name = 'avg_unit_cost'`,
  );
  if (costing.rows[0].present !== 1) {
    throw new Error(
      'inventory.stock_balance.avg_unit_cost is missing, so nothing can be valued and every goods receipt '
      + 'would fail. Run: node scripts/migrate-local.mjs — the reset should already have applied it.',
    );
  }

  // Demo fixture: the seeded checker is CONTROLLER with GL-APPROVE. Platform keeps
  // ownership of the approval engine; this root fixture selects its registered route.
  await pool.query(
    `UPDATE platform.approval_level level SET role_code = 'CONTROLLER'
     FROM platform.approval_policy policy
     WHERE level.policy_id = policy.id AND policy.type_code = 'journal'
       AND level.permission_code = 'finance.journal.approve'`,
  );
  for (const terminal of terminals) {
    if (await exists('SELECT 1 FROM pos.pos_terminal WHERE organization_id = $1 AND code = $2', [organizationId, terminal.code])) continue;
    await registerPosTerminal(pool, undefined, { organizationId, branchId, warehouseId, code: terminal.code, name: terminal.name, ...meta });
  }

  // Product ids come from the command, not from this file. An earlier version of this seed carried a
  // fixed id per catalog row and used it for the price and the receipt — which silently wrote prices
  // and stock against product ids that did not exist, because `createProduct` mints its own. The
  // created id is read back by SKU, so a price and a receipt can only ever name a real product.
  const priced = [];
  for (const product of catalog) {
    if (!await exists('SELECT 1 FROM core.product WHERE organization_id = $1 AND sku = $2', [organizationId, product.sku])) {
      await createProduct(pool, undefined, {
        organizationId, sku: product.sku, name: product.name, baseUom: product.baseUom,
        orderCapture: 'PSS', status: 'ACTIVE', ...meta,
      });
    }
    const stored = await pool.query(
      'SELECT id FROM core.product WHERE organization_id = $1 AND sku = $2', [organizationId, product.sku],
    );
    const productId = stored.rows[0].id;
    const [caseUom, caseFactor] = product.case;

    if (caseUom !== product.baseUom) {
      try {
        await addProductUom(pool, undefined, { organizationId, productId, uom: caseUom, conversionFactor: String(caseFactor), ...meta });
      } catch (error) {
        // A second run finds the unit already there, which the command answers as DUPLICATE_CODE.
        if (error?.code !== 'DUPLICATE_CODE') throw error;
      }
    }
    for (const barcode of product.barcodes) {
      if (await exists('SELECT 1 FROM core.product_barcode WHERE barcode = $1', [barcode.code])) continue;
      await addProductBarcode(pool, undefined, { organizationId, productId, uom: barcode.uom, barcode: barcode.code, ...meta });
    }
    priced.push({ productId, uom: caseUom, unitPrice: product.price, cost: product.cost, qty: product.qty });
  }

  // One ACTIVE KONTER list priced per case unit, through `commercial`'s own command so the demo's
  // price came from a validated, audited, versioned write rather than a fixture insert.
  if (!await exists('SELECT 1 FROM core.price_list WHERE id = $1', [priceListId])) {
    await activatePriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-09-01',
      items: priced.map((item) => ({ productId: item.productId, uom: item.uom, unitPrice: item.unitPrice })),
      ...meta,
    });
  }

  // The opening stock, as a costed goods receipt. One `INVENTORY_RECEIVED` per product, which is what
  // puts a value on the shelf (Dr Persediaan / Cr Barang Diterima Belum Ditagih) and gives the demo's
  // first sale a cost of goods sold to measure a margin against.
  for (const item of priced) {
    if (await exists(
      'SELECT 1 FROM inventory.stock_balance WHERE organization_id = $1 AND warehouse_id = $2 AND product_id = $3',
      [organizationId, warehouseId, item.productId],
    )) continue;
    await receiveStock(pool, undefined, {
      organizationId, warehouseId, sourceType: 'GOODS_RECEIPT', referenceType: 'GOODS_RECEIPT',
      referenceId: randomUUID(), lines: [{ productId: item.productId, uom: item.uom, qty: item.qty, unitCost: item.cost }],
      ...meta,
    });
  }

  // And the one about what this run produced: the opening stock is costed, so no balance may be left
  // unvalued. A margin read against a blank cost is a number nobody can explain.
  const unvalued = await pool.query(
    'SELECT count(*)::int AS count FROM inventory.stock_balance WHERE avg_unit_cost IS NULL',
  );
  if (unvalued.rows[0].count > 0) {
    throw new Error(
      `${unvalued.rows[0].count} stock balances have no value. The demo's gross margin reads from the `
      + 'moving average, so an unvalued balance makes it a number nobody can explain.',
    );
  }

  const totalValue = await pool.query(
    'SELECT COALESCE(sum(round(qty_on_hand * avg_unit_cost, 2)), 0)::text AS value FROM inventory.stock_balance',
  );

  process.stdout.write(
    `MVP demo data ready: ${terminals.length} terminals, ${catalog.length} products `
    + `(${new Set(catalog.map((product) => product.category)).size} categories) with costed opening stock `
    + `worth ${rupiahOf(totalValue.rows[0].value)} in ${demo.warehouse.name}.\n`,
  );
} finally {
  await pool.end();
}
