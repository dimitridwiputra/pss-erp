import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomer } from '../src/application/create-customer';
import { findProductByBarcode } from '../src/application/find-product-by-barcode';
import { getOrCreateWalkInCustomer } from '../src/application/get-or-create-walk-in-customer';
import { searchProducts } from '../src/application/search-products';

const databaseName = `pss_master_data_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  // audit.audit_entry is a prerequisite: withAuditedTransaction (called by createCustomer /
  // getOrCreateWalkInCustomer) writes into it, and one test asserts on it directly.
  const auditMigration = await readFile(new URL('../../audit/infrastructure/database/migrations/0001_audit_entry.sql', import.meta.url), 'utf8');
  await pool.query(auditMigration);
  const migration = await readFile(new URL('../infrastructure/database/migrations/0001_master_data.sql', import.meta.url), 'utf8');
  await pool.query(migration);
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('master-data walk-in customer provisioning', () => {
  it('is idempotent for a branch that already has a walk-in customer', async () => {
    const organizationId = randomUUID();
    const branchId = randomUUID();

    const first = await getOrCreateWalkInCustomer(pool, { organizationId, branchId });
    const second = await getOrCreateWalkInCustomer(pool, { organizationId, branchId });

    expect(second.id).toBe(first.id);
    expect(first.name).toBe('Pelanggan Umum Grosir');
    expect(first.status).toBe('ACTIVE');

    const rows = await pool.query('SELECT count(*)::int AS count FROM core.customer WHERE organization_id = $1 AND branch_id = $2 AND is_walk_in = true', [organizationId, branchId]);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('resolves two concurrent calls for the same branch to the same customer', async () => {
    const organizationId = randomUUID();
    const branchId = randomUUID();

    const [a, b] = await Promise.all([
      getOrCreateWalkInCustomer(pool, { organizationId, branchId }),
      getOrCreateWalkInCustomer(pool, { organizationId, branchId }),
    ]);

    expect(a.id).toBe(b.id);
    const rows = await pool.query('SELECT count(*)::int AS count FROM core.customer WHERE organization_id = $1 AND branch_id = $2 AND is_walk_in = true', [organizationId, branchId]);
    expect(rows.rows[0]?.count).toBe(1);
  });
});

describe('master-data customer quick registration', () => {
  it('creates a PENDING_REVIEW customer with exactly one audit entry', async () => {
    const organizationId = randomUUID();

    const created = await createCustomer(pool, {
      organizationId,
      name: 'Toko Baru Jaya',
      phone: '081234567890',
      npwp: '01.234.567.8-901.000',
      actor: { userId: randomUUID(), roles: ['SALES_ADMIN'] },
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: 'WEB',
    });

    expect(created.status).toBe('PENDING_REVIEW');
    expect(created.code).toMatch(/^CUS-[0-9A-F]{6}$/);

    const auditCount = await pool.query(
      "SELECT count(*)::int AS count FROM audit.audit_entry WHERE entity_type = 'Customer' AND entity_id = $1",
      [created.id],
    );
    expect(auditCount.rows[0]?.count).toBe(1);
  });

  it('keeps same-named customers in separate branches as distinct canonical identities', async () => {
    const organizationId = randomUUID();
    const actor = { userId: randomUUID(), roles: ['SALES_ADMIN'] };
    const register = (branchId: string) => createCustomer(pool, {
      organizationId, branchId, name: 'Toko Makmur', actor,
      requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB',
    });

    const first = await register(randomUUID());
    const second = await register(randomUUID());

    expect(first.id).not.toBe(second.id);
    expect(first.code).not.toBe(second.code);
    expect(first.name).toBe(second.name);
    expect(first.status).toBe('PENDING_REVIEW');
    expect(second.status).toBe('PENDING_REVIEW');
    const result = await pool.query(
      'SELECT count(*)::int AS count FROM core.customer WHERE organization_id = $1 AND name = $2',
      [organizationId, 'Toko Makmur'],
    );
    expect(result.rows[0]?.count).toBe(2);
  });
});

describe('master-data product read model', () => {
  it('finds a product by a barcode and returns that barcode\'s own UOM row', async () => {
    const organizationId = randomUUID();
    const productId = randomUUID();

    await pool.query(
      `INSERT INTO core.product (id, organization_id, sku, name, base_uom, status)
       VALUES ($1, $2, 'SKU-BARCODE-001', 'Produk Uji Barcode', 'PCS', 'ACTIVE')`,
      [productId, organizationId],
    );
    await pool.query(
      `INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base)
       VALUES ($1, $2, 'PCS', 1, true), ($3, $2, 'DUS', 12, false)`,
      [randomUUID(), productId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO core.product_barcode (id, product_id, uom, barcode) VALUES ($1, $2, 'DUS', $3)`,
      [randomUUID(), productId, '8991111111111'],
    );

    const match = await findProductByBarcode(pool, { organizationId, barcode: '8991111111111' });
    expect(match).not.toBeNull();
    expect(match?.productId).toBe(productId);
    expect(match?.uom).toBe('DUS');
    expect(match?.baseUom).toBe('PCS');
    expect(match?.conversionFactor).toBe(12);

    const miss = await findProductByBarcode(pool, { organizationId, barcode: 'does-not-exist' });
    expect(miss).toBeNull();
  });

  it('searches products by partial SKU or name', async () => {
    const organizationId = randomUUID();

    await pool.query(
      `INSERT INTO core.product (id, organization_id, sku, name, base_uom, status)
       VALUES ($1, $2, 'ABC-100', 'Minyak Goreng 1L', 'PCS', 'ACTIVE'),
              ($3, $2, 'XYZ-200', 'Gula Pasir 1KG', 'PCS', 'ACTIVE')`,
      [randomUUID(), organizationId, randomUUID()],
    );

    const bySku = await searchProducts(pool, { organizationId, query: 'ABC' });
    expect(bySku).toHaveLength(1);
    expect(bySku[0]?.sku).toBe('ABC-100');

    const byName = await searchProducts(pool, { organizationId, query: 'goreng' });
    expect(byName).toHaveLength(1);
    expect(byName[0]?.name).toBe('Minyak Goreng 1L');

    const noMatch = await searchProducts(pool, { organizationId, query: 'tidak-ada' });
    expect(noMatch).toHaveLength(0);
  });
});
