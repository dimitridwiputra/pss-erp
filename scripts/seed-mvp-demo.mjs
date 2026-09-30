import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import pg from 'pg';

/**
 * Local MVP demo data (docs/mvp/MVP_PLAN.md, MVP-OD-6: synthetic sample products). Safe to re-run:
 * every row has a fixed id or is guarded by a lookup, so a second run changes nothing.
 *
 * Uses each owning domain's exported command where one exists: `registerPosTerminal` (pos) and
 * `receiveStock` (inventory). Products, barcodes and the KONTER price list have no create command
 * yet (OpenCode's MVP_PLAN §6.3 work), so they are inserted here the way the integration fixtures
 * do. Switch those inserts to OpenCode's commands once they merge.
 *
 * Needs `pnpm build` (loads each domain's dist) and the demo identity from `pnpm idp:setup:local`.
 */
const require = createRequire(import.meta.url);
const { registerPosTerminal } = require('../domains/pos/dist/index.js');
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
// Synthetic demo values only (MVP-OD-6). Prices and pack sizes are placeholders, not PSS data.
const products = [
  { id: '0199a000-0000-7000-8000-00000000d401', sku: 'DEMO-001', name: 'Mi Goreng 80g', baseUom: 'PCS', uom: 'KARTON', factor: 40, barcode: '8990001000012', price: '118000.00' },
  { id: '0199a000-0000-7000-8000-00000000d402', sku: 'DEMO-002', name: 'Air Mineral 600ml', baseUom: 'BTL', uom: 'KARTON', factor: 24, barcode: '8990001000029', price: '48000.00' },
  { id: '0199a000-0000-7000-8000-00000000d403', sku: 'DEMO-003', name: 'Minuman Cokelat 200ml', baseUom: 'PCS', uom: 'KARTON', factor: 36, barcode: '8990001000036', price: '126000.00' },
  { id: '0199a000-0000-7000-8000-00000000d404', sku: 'DEMO-004', name: 'Saus Sambal 340ml', baseUom: 'BTL', uom: 'BTL', factor: 1, barcode: '8990001000043', price: '12000.00' },
];
const openingStock = '50';

const pool = new pg.Pool({ connectionString: databaseUrl });
const meta = { actor: { roles: [], serviceIdentity: 'mvp-demo-seed' }, requestId: randomUUID(), correlationId: randomUUID(), source: 'SYSTEM' };

try {
  // Demo fixture: the seeded checker is CONTROLLER with GL-APPROVE. Platform keeps
  // ownership of the approval engine; this root fixture selects its registered route.
  await pool.query(
    `UPDATE platform.approval_level level SET role_code = 'CONTROLLER'
     FROM platform.approval_policy policy
     WHERE level.policy_id = policy.id AND policy.type_code = 'journal'
       AND level.permission_code = 'finance.journal.approve'`,
  );
  for (const terminal of terminals) {
    const existing = await pool.query('SELECT 1 FROM pos.pos_terminal WHERE organization_id = $1 AND code = $2', [organizationId, terminal.code]);
    if (existing.rowCount) continue;
    await registerPosTerminal(pool, undefined, { organizationId, branchId, warehouseId, code: terminal.code, name: terminal.name, ...meta });
  }

  await pool.query(
    `INSERT INTO core.price_list (id, organization_id, scope, status, valid_from)
     VALUES ($1, $2, 'KONTER', 'ACTIVE', '2026-09-01') ON CONFLICT (id) DO NOTHING`,
    [priceListId, organizationId],
  );
  for (const product of products) {
    await pool.query(
      `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status)
       VALUES ($1, $2, $3, $4, $5, 'PSS', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [product.id, organizationId, product.sku, product.name, product.baseUom],
    );
    const hasUom = await pool.query('SELECT 1 FROM core.product_uom WHERE product_id = $1 AND uom = $2', [product.id, product.uom]);
    if (!hasUom.rowCount) {
      await pool.query(
        'INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), product.id, product.uom, product.factor, product.uom === product.baseUom],
      );
    }
    const hasBarcode = await pool.query('SELECT 1 FROM core.product_barcode WHERE barcode = $1', [product.barcode]);
    if (!hasBarcode.rowCount) {
      await pool.query('INSERT INTO core.product_barcode (id, product_id, uom, barcode) VALUES ($1, $2, $3, $4)', [randomUUID(), product.id, product.uom, product.barcode]);
    }
    const hasPrice = await pool.query('SELECT 1 FROM core.price_list_item WHERE price_list_id = $1 AND product_id = $2 AND uom = $3', [priceListId, product.id, product.uom]);
    if (!hasPrice.rowCount) {
      await pool.query(
        'INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), priceListId, product.id, product.uom, product.price],
      );
    }
    const hasStock = await pool.query('SELECT 1 FROM inventory.stock_balance WHERE warehouse_id = $1 AND product_id = $2 AND uom = $3', [warehouseId, product.id, product.uom]);
    if (!hasStock.rowCount) {
      await receiveStock(pool, undefined, {
        organizationId, warehouseId, referenceType: 'MVP_DEMO_SEED', referenceId: product.id,
        lines: [{ productId: product.id, uom: product.uom, qty: openingStock }], ...meta,
      });
    }
  }
  process.stdout.write(`MVP demo data ready: ${terminals.length} terminals, ${products.length} products in ${demo.warehouse.name}.\n`);
} finally {
  await pool.end();
}
