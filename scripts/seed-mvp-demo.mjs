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
 * Twenty FMCG items across four categories, each with a base unit, a case unit, a barcode per unit
 * and a price, so the counter can scan either the piece or the case and the back office can show a
 * catalog worth looking at. Synthetic values (MVP-OD-6): the names are generic Indonesian grocery
 * categories, and the barcodes, prices and costs are placeholders.
 *
 * `cost` is what makes the demo's gross profit real: it is the unit cost the opening receipt posts,
 * and it is deliberately below `price` so a sale shows revenue, cost and margin rather than revenue
 * alone.
 */
const catalog = [
  // ── Mie Instan ──────────────────────────────────────────────────────────────
  { id: '0199a000-0000-7000-8000-00000000d401', sku: 'DEMO-001', name: 'Mi Instan Goreng 80g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 40], barcode: '8990001000012', caseBarcode: '8990001100019', price: '118000.00', cost: '95000.00', qty: '40' },
  { id: '0199a000-0000-7000-8000-00000000d402', sku: 'DEMO-002', name: 'Mi Instan Kuah Ayam Bawang 65g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 40], barcode: '8990001000029', caseBarcode: '8990001100026', price: '112000.00', cost: '91000.00', qty: '40' },
  { id: '0199a000-0000-7000-8000-00000000d403', sku: 'DEMO-003', name: 'Mi Instan Goreng Ayam Special 85g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 30], barcode: '8990001000036', caseBarcode: '8990001100033', price: '126000.00', cost: '103000.00', qty: '30' },
  { id: '0199a000-0000-7000-8000-00000000d404', sku: 'DEMO-004', name: 'Mi Instan Kuah Soto 85g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 30], barcode: '8990001000043', caseBarcode: '8990001100040', price: '121000.00', cost: '99000.00', qty: '30' },
  { id: '0199a000-0000-7000-8000-00000000d405', sku: 'DEMO-005', name: 'Mi Instan Goreng Rendang 85g', category: 'MIE INSTAN', baseUom: 'PCS', case: ['KARTON', 30], barcode: '8990001000050', caseBarcode: '8990001100057', price: '124000.00', cost: '101000.00', qty: '30' },

  // ── Minuman ─────────────────────────────────────────────────────────────────
  { id: '0199a000-0000-7000-8000-00000000d406', sku: 'DEMO-006', name: 'Air Mineral 600ml', category: 'MINUMAN', baseUom: 'BTL', case: ['KARTON', 24], barcode: '8990001000067', caseBarcode: '8990001100064', price: '48000.00', cost: '38000.00', qty: '24' },
  { id: '0199a000-0000-7000-8000-00000000d407', sku: 'DEMO-007', name: 'Minuman Isotonik 500ml', category: 'MINUMAN', baseUom: 'BTL', case: ['KARTON', 24], barcode: '8990001000074', caseBarcode: '8990001100071', price: '54000.00', cost: '43000.00', qty: '24' },
  { id: '0199a000-0000-7000-8000-00000000d408', sku: 'DEMO-008', name: 'Minuman Cokelat 200ml', category: 'MINUMAN', baseUom: 'PCS', case: ['KARTON', 36], barcode: '8990001000081', caseBarcode: '8990001100088', price: '126000.00', cost: '104000.00', qty: '36' },
  { id: '0199a000-0000-7000-8000-00000000d409', sku: 'DEMO-009', name: 'Susu UHT Full Cream 1L', category: 'MINUMAN', baseUom: 'PCS', case: ['KARTON', 12], barcode: '8990001000098', caseBarcode: '8990001100095', price: '168000.00', cost: '142000.00', qty: '12' },
  { id: '0199a000-0000-7000-8000-00000000d410', sku: 'DEMO-010', name: 'Teh Celup Melati 25s', category: 'MINUMAN', baseUom: 'BKS', case: ['KARTON', 12], barcode: '8990001000104', caseBarcode: '8990001100101', price: '62000.00', cost: '49000.00', qty: '12' },

  // ── Bumbu & Sambal ──────────────────────────────────────────────────────────
  { id: '0199a000-0000-7000-8000-00000000d411', sku: 'DEMO-011', name: 'Saus Sambal 340ml', category: 'BUMBU', baseUom: 'BTL', case: ['KARTON', 12], barcode: '8990001000111', caseBarcode: '8990001100118', price: '12000.00', cost: '8600.00', qty: '12' },
  { id: '0199a000-0000-7000-8000-00000000d412', sku: 'DEMO-012', name: 'Kecap Manis 520ml', category: 'BUMBU', baseUom: 'BTL', case: ['KARTON', 12], barcode: '8990001000128', caseBarcode: '8990001100125', price: '23500.00', cost: '19000.00', qty: '12' },
  { id: '0199a000-0000-7000-8000-00000000d413', sku: 'DEMO-013', name: 'Minyak Goreng 1L', category: 'BUMBU', baseUom: 'BTL', case: ['KARTON', 12], barcode: '8990001000135', caseBarcode: '8990001100132', price: '178000.00', cost: '156000.00', qty: '12' },
  { id: '0199a000-0000-7000-8000-00000000d414', sku: 'DEMO-014', name: 'Gula Pasir 1kg', category: 'BUMBU', baseUom: 'BKS', case: ['KARTON', 10], barcode: '8990001000142', caseBarcode: '8990001100149', price: '152000.00', cost: '134000.00', qty: '10' },
  { id: '0199a000-0000-7000-8000-00000000d415', sku: 'DEMO-015', name: 'Garam Halus 250g', category: 'BUMBU', baseUom: 'BKS', case: ['KARTON', 40], barcode: '8990001000159', caseBarcode: '8990001100156', price: '18000.00', cost: '12000.00', qty: '40' },

  // ── Snack & Kebutuhan Rumah ────────────────────────────────────────────────
  { id: '0199a000-0000-7000-8000-00000000d416', sku: 'DEMO-016', name: 'Biskuit Kelapa 300g', category: 'SNACK', baseUom: 'BKS', case: ['KARTON', 24], barcode: '8990001000166', caseBarcode: '8990001100163', price: '96000.00', cost: '78000.00', qty: '24' },
  { id: '0199a000-0000-7000-8000-00000000d417', sku: 'DEMO-017', name: 'Keripik Kentang Ori 68g', category: 'SNACK', baseUom: 'PCS', case: ['KARTON', 36], barcode: '8990001000173', caseBarcode: '8990001100170', price: '84000.00', cost: '67000.00', qty: '36' },
  { id: '0199a000-0000-7000-8000-00000000d418', sku: 'DEMO-018', name: 'Cokelat Batang 70g', category: 'SNACK', baseUom: 'PCS', case: ['KARTON', 48], barcode: '8990001000180', caseBarcode: '8990001100187', price: '132000.00', cost: '108000.00', qty: '48' },
  { id: '0199a000-0000-7000-8000-00000000d419', sku: 'DEMO-019', name: 'Kopi Bubuk Instan 20s', category: 'SNACK', baseUom: 'PCS', case: ['KARTON', 24], barcode: '8990001000197', caseBarcode: '8990001100194', price: '108000.00', cost: '89000.00', qty: '24' },
  { id: '0199a000-0000-7000-8000-00000000d420', sku: 'DEMO-020', name: 'Sabun Mandi Cair 825ml', category: 'RUMAH', baseUom: 'BTL', case: ['KARTON', 12], barcode: '8990001000203', caseBarcode: '8990001100200', price: '186000.00', cost: '158000.00', qty: '12' },
];

const pool = new pg.Pool({ connectionString: databaseUrl });
const meta = { actor: { roles: [], serviceIdentity: 'mvp-demo-seed' }, requestId: randomUUID(), correlationId: randomUUID(), source: 'SYSTEM' };

async function exists(sql, values) {
  const found = await pool.query(sql, values);
  return Boolean(found.rowCount);
}

try {
  for (const terminal of terminals) {
    if (await exists('SELECT 1 FROM pos.pos_terminal WHERE organization_id = $1 AND code = $2', [organizationId, terminal.code])) continue;
    await registerPosTerminal(pool, undefined, { organizationId, branchId, warehouseId, code: terminal.code, name: terminal.name, ...meta });
  }

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
    for (const [uom, barcode] of [[product.baseUom, product.barcode], [caseUom, product.caseBarcode]]) {
      if (await exists('SELECT 1 FROM core.product_barcode WHERE barcode = $1', [barcode])) continue;
      await addProductBarcode(pool, undefined, { organizationId, productId, uom, barcode, ...meta });
    }
  }

  // One ACTIVE KONTER list priced per case unit, through `commercial`'s own command so the demo's
  // price came from a validated, audited, versioned write.
  if (!await exists('SELECT 1 FROM core.price_list WHERE id = $1', [priceListId])) {
    await activatePriceList(pool, undefined, {
      organizationId, scope: 'KONTER', validFrom: '2026-09-01',
      items: catalog.map((product) => ({ productId: product.id, uom: product.case[0], unitPrice: product.price })),
      ...meta,
    });
  }

  // The opening stock, as a costed goods receipt. `INVENTORY_RECEIVED` per product, which is what
  // puts a value on the shelf and gives the demo's first sale something to be measured against.
  for (const product of catalog) {
    if (await exists(
      'SELECT 1 FROM inventory.stock_balance WHERE organization_id = $1 AND warehouse_id = $2 AND product_id = $3',
      [organizationId, warehouseId, product.id],
    )) continue;
    await receiveStock(pool, undefined, {
      organizationId, warehouseId, sourceType: 'GOODS_RECEIPT', referenceType: 'GOODS_RECEIPT',
      referenceId: randomUUID(), lines: [{ productId: product.id, uom: product.case[0], qty: product.qty, unitCost: product.cost }],
      ...meta,
    });
  }

  process.stdout.write(
    `MVP demo data ready: ${terminals.length} terminals, ${catalog.length} products `
    + `(${new Set(catalog.map((product) => product.category)).size} categories) with costed opening stock in ${demo.warehouse.name}.\n`,
  );
} finally {
  await pool.end();
}
