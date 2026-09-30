import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import { createCustomer } from '../src/application/create-customer';
import { findProductByBarcode } from '../src/application/find-product-by-barcode';
import { getOrCreateWalkInCustomer } from '../src/application/get-or-create-walk-in-customer';
import { searchProducts } from '../src/application/search-products';
import { createProduct } from '../src/application/create-product';
import { updateProduct } from '../src/application/update-product';
import { addProductBarcode } from '../src/application/add-product-barcode';
import { addProductUom } from '../src/application/add-product-uom';
import { getProduct, getProductSaleUnits } from '../src/application/get-product';
import { listCustomers } from '../src/application/list-customers';
import { applyAuditMigrations, applyDomainMigrations } from '../../../scripts/apply-migrations.mjs';

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
  // The whole audit domain, not one file: a fixture that replays only
  // 0001 is what made amending a shipped migration look safe (MIG-RISK-AUD-001).
  await applyAuditMigrations(pool);
  // This domain's ordered migration list, not a named file, so a migration added later runs here
  // rather than being silently skipped.
  await applyDomainMigrations((sql) => pool.query(sql), 'master-data');
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

describe('master-data product commands (MVP back office)', () => {
  const actor = () => ({ userId: randomUUID(), roles: ['MASTER_DATA_STEWARD'] });
  const meta = () => ({ actor: actor(), requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const });

  async function seedProduct(organizationId: string, overrides: Record<string, unknown> = {}) {
    return createProduct(pool, undefined, {
      organizationId, sku: `BRG-${randomUUID().slice(0, 8)}`, name: 'Mi Instan 85g', baseUom: 'PCS', ...meta(), ...overrides,
    });
  }

  it('creates a DRAFT product with its base unit and one audit entry', async () => {
    const organizationId = randomUUID();
    const created = await seedProduct(organizationId, { sku: 'BRG-DRAFT-1', status: 'ACTIVE' });

    expect(created.status).toBe('ACTIVE');
    expect(created.orderCapture).toBe('PSS');
    expect(created.version).toBe(1);

    const units = await pool.query(
      'SELECT uom, conversion_factor, is_base FROM core.product_uom WHERE product_id = $1', [created.productId],
    );
    expect(units.rows).toEqual([{ uom: 'PCS', conversion_factor: '1.000000', is_base: true }]);

    const auditCount = await pool.query(
      "SELECT count(*)::int AS count FROM audit.audit_entry WHERE entity_type = 'Product' AND entity_id = $1",
      [created.productId],
    );
    expect(auditCount.rows[0]?.count).toBe(1);
  });

  it('starts a product DRAFT when no status is given, so it cannot be sold before it is priced', async () => {
    const organizationId = randomUUID();
    const created = await seedProduct(organizationId);
    expect(created.status).toBe('DRAFT');
  });

  it('refuses a duplicate SKU in the same organization with a field-level message', async () => {
    const organizationId = randomUUID();
    await seedProduct(organizationId, { sku: 'BRG-DUP-1' });

    const attempt = await seedProduct(organizationId, { sku: 'BRG-DUP-1' }).catch((error) => error);
    expect(attempt).toBeInstanceOf(DomainError);
    expect((attempt as DomainError).code).toBe('DUPLICATE_CODE');
    expect((attempt as DomainError).fieldErrors?.[0]?.path).toBe('sku');
    expect((attempt as DomainError).fieldErrors?.[0]?.message).toBe('Kode barang BRG-DUP-1 sudah dipakai.');
  });

  it('allows the same SKU in another organization', async () => {
    const first = await seedProduct(randomUUID(), { sku: 'BRG-SHARED-1' });
    const second = await seedProduct(randomUUID(), { sku: 'BRG-SHARED-1' });
    expect(first.productId).not.toBe(second.productId);
  });

  it('rolls the whole product back when its SKU is a duplicate', async () => {
    const organizationId = randomUUID();
    await seedProduct(organizationId, { sku: 'BRG-ROLLBACK-1' });
    await seedProduct(organizationId, { sku: 'BRG-ROLLBACK-1' }).catch(() => undefined);

    const orphans = await pool.query(
      `SELECT count(*)::int AS count FROM core.product_uom u
       WHERE NOT EXISTS (SELECT 1 FROM core.product p WHERE p.id = u.product_id)`,
    );
    expect(orphans.rows[0]?.count).toBe(0);
  });
});

describe('master-data updateProduct', () => {
  const meta = () => ({ actor: { userId: randomUUID(), roles: ['MASTER_DATA_STEWARD'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const });

  it('bumps the version and records the before and after values', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: 'BRG-UPD-1', name: 'Nama Lama', baseUom: 'PCS', ...meta(),
    });

    const updated = await updateProduct(pool, undefined, {
      organizationId, productId: product.productId, name: 'Nama Baru', expectedVersion: 1, ...meta(),
    });

    expect(updated.version).toBe(2);
    const audit = await pool.query(
      `SELECT changes FROM audit.audit_entry
       WHERE action = 'PRODUCT_UPDATED' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [product.productId],
    );
    expect(audit.rows[0]?.changes).toEqual([
      expect.objectContaining({ path: 'name', before: 'Nama Lama', after: 'Nama Baru' }),
    ]);
  });

  it('rejects a stale edit with STALE_DATA rather than overwriting a change the operator never saw', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: 'BRG-UPD-2', name: 'Nama Satu', baseUom: 'PCS', ...meta(),
    });
    await updateProduct(pool, undefined, { organizationId, productId: product.productId, name: 'Nama Dua', expectedVersion: 1, ...meta() });

    const attempt = await updateProduct(pool, undefined, {
      organizationId, productId: product.productId, name: 'Nama Tiga', expectedVersion: 1, ...meta(),
    }).catch((error) => error);

    expect((attempt as DomainError).code).toBe('STALE_DATA');
    const current = await getProduct(pool, undefined, { organizationId, productId: product.productId });
    expect(current.name).toBe('Nama Dua');
  });

  it('reports a product in another organization as NOT_FOUND', async () => {
    const product = await createProduct(pool, undefined, {
      organizationId: randomUUID(), sku: 'BRG-UPD-3', name: 'Milik Orang Lain', baseUom: 'PCS', ...meta(),
    });
    const attempt = await updateProduct(pool, undefined, {
      organizationId: randomUUID(), productId: product.productId, name: 'Dibajak', ...meta(),
    }).catch((error) => error);

    expect((attempt as DomainError).code).toBe('NOT_FOUND');
  });

  it('still writes an audit entry when the submitted values are already the stored ones', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: 'BRG-UPD-4', name: 'Sama', baseUom: 'PCS', ...meta(),
    });

    const result = await updateProduct(pool, undefined, {
      organizationId, productId: product.productId, name: 'Sama', ...meta(),
    });

    expect(result.version).toBe(1);
    const audit = await pool.query(
      "SELECT count(*)::int AS count FROM audit.audit_entry WHERE action = 'PRODUCT_UPDATED' AND entity_id = $1",
      [product.productId],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it('refuses a body that changes nothing at all', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: 'BRG-UPD-5', name: 'Kosong', baseUom: 'PCS', ...meta(),
    });
    const attempt = await updateProduct(pool, undefined, {
      organizationId, productId: product.productId, ...meta(),
    }).catch((error) => error);
    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
  });
});

describe('master-data barcodes and units', () => {
  const meta = () => ({ actor: { userId: randomUUID(), roles: ['MASTER_DATA_STEWARD'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const });

  async function productWithKarton(organizationId: string) {
    const product = await createProduct(pool, undefined, {
      organizationId, sku: `BRG-${randomUUID().slice(0, 8)}`, name: 'Susu UHT 1L', baseUom: 'PCS', ...meta(),
    });
    await addProductUom(pool, undefined, { organizationId, productId: product.productId, uom: 'KARTON', conversionFactor: '12', ...meta() });
    return product;
  }

  it('adds a case unit with its conversion factor and then a barcode for that unit', async () => {
    const organizationId = randomUUID();
    const product = await productWithKarton(organizationId);

    const barcode = await addProductBarcode(pool, undefined, {
      organizationId, productId: product.productId, uom: 'KARTON', barcode: '8992222222229', ...meta(),
    });
    expect(barcode.uom).toBe('KARTON');

    const match = await findProductByBarcode(pool, { organizationId, barcode: '8992222222229' });
    expect(match?.uom).toBe('KARTON');
    expect(match?.conversionFactor).toBe(12);
  });

  it('refuses a barcode already used, with a stable code and an Indonesian field message', async () => {
    const organizationId = randomUUID();
    const first = await productWithKarton(organizationId);
    const second = await productWithKarton(organizationId);
    await addProductBarcode(pool, undefined, { organizationId, productId: first.productId, uom: 'PCS', barcode: '8993333333333', ...meta() });

    const attempt = await addProductBarcode(pool, undefined, {
      organizationId, productId: second.productId, uom: 'PCS', barcode: '8993333333333', ...meta(),
    }).catch((error) => error);

    expect(attempt).toBeInstanceOf(DomainError);
    expect((attempt as DomainError).code).toBe('DUPLICATE_CODE');
    expect((attempt as DomainError).fieldErrors?.[0]?.path).toBe('barcode');
    expect((attempt as DomainError).fieldErrors?.[0]?.message)
      .toBe('Barcode 8993333333333 sudah dipakai barang lain. Gunakan barcode yang lain.');
  });

  it('refuses a barcode for a unit the product does not sell', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: `BRG-${randomUUID().slice(0, 8)}`, name: 'Teh Celup', baseUom: 'PCS', ...meta(),
    });

    const attempt = await addProductBarcode(pool, undefined, {
      organizationId, productId: product.productId, uom: 'KARTON', barcode: '8994444444440', ...meta(),
    }).catch((error) => error);

    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
    expect((attempt as DomainError).fieldErrors?.[0]?.message).toContain('Satuan KARTON belum ada');
  });

  it('refuses a malformed barcode before it reaches the database', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: `BRG-${randomUUID().slice(0, 8)}`, name: 'Kopi Sachet', baseUom: 'PCS', ...meta(),
    });
    const attempt = await addProductBarcode(pool, undefined, {
      organizationId, productId: product.productId, uom: 'PCS', barcode: 'abc 123!', ...meta(),
    }).catch((error) => error);
    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
  });

  it('refuses a duplicate unit and a non-positive conversion factor', async () => {
    const organizationId = randomUUID();
    const product = await productWithKarton(organizationId);

    const duplicate = await addProductUom(pool, undefined, {
      organizationId, productId: product.productId, uom: 'KARTON', conversionFactor: '12', ...meta(),
    }).catch((error) => error);
    expect((duplicate as DomainError).code).toBe('DUPLICATE_CODE');

    const zero = await addProductUom(pool, undefined, {
      organizationId, productId: product.productId, uom: 'LUSIN', conversionFactor: '0', ...meta(),
    }).catch((error) => error);
    expect((zero as DomainError).code).toBe('VALIDATION_FAILED');
    expect((zero as DomainError).fieldErrors?.[0]?.path).toBe('conversionFactor');
  });

  it('reports a product in another organization as NOT_FOUND for both commands', async () => {
    const organizationId = randomUUID();
    const product = await productWithKarton(organizationId);
    const elsewhere = randomUUID();

    const barcode = await addProductBarcode(pool, undefined, {
      organizationId: elsewhere, productId: product.productId, uom: 'PCS', barcode: '8995555555556', ...meta(),
    }).catch((error) => error);
    expect((barcode as DomainError).code).toBe('NOT_FOUND');

    const uom = await addProductUom(pool, undefined, {
      organizationId: elsewhere, productId: product.productId, uom: 'PAKET', conversionFactor: '2', ...meta(),
    }).catch((error) => error);
    expect((uom as DomainError).code).toBe('NOT_FOUND');
  });
});

describe('master-data getProduct and getProductSaleUnits', () => {
  const meta = () => ({ actor: { userId: randomUUID(), roles: ['MASTER_DATA_STEWARD'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const });

  it('returns the product with its units, base unit first, and each unit barcode', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: 'BRG-GET-1', name: 'Mie Instan', baseUom: 'PCS', status: 'ACTIVE', ...meta(),
    });
    await addProductUom(pool, undefined, { organizationId, productId: product.productId, uom: 'KARTON', conversionFactor: '40', ...meta() });
    await addProductBarcode(pool, undefined, { organizationId, productId: product.productId, uom: 'KARTON', barcode: '8996666666665', ...meta() });
    await addProductBarcode(pool, undefined, { organizationId, productId: product.productId, uom: 'PCS', barcode: '8996666666666', ...meta() });

    const detail = await getProduct(pool, undefined, { organizationId, productId: product.productId });
    expect(detail.units.map((unit) => unit.uom)).toEqual(['PCS', 'KARTON']);
    expect(detail.units[0]).toMatchObject({ isBase: true, conversionFactor: '1.000000', barcode: '8996666666666' });
    expect(detail.units[1]).toMatchObject({ isBase: false, conversionFactor: '40.000000', barcode: '8996666666665' });

    const forPos = await getProductSaleUnits(pool, undefined, { organizationId, productId: product.productId });
    expect(forPos).toEqual({
      productId: product.productId, sku: 'BRG-GET-1', name: 'Mie Instan', status: 'ACTIVE', orderCapture: 'PSS',
      units: [{ uom: 'PCS', barcode: '8996666666666' }, { uom: 'KARTON', barcode: '8996666666665' }],
    });
  });

  it('reports a null barcode for a unit that has no label', async () => {
    const organizationId = randomUUID();
    const product = await createProduct(pool, undefined, {
      organizationId, sku: 'BRG-GET-2', name: 'Gula', baseUom: 'PCS', ...meta(),
    });
    const detail = await getProduct(pool, undefined, { organizationId, productId: product.productId });
    expect(detail.units).toEqual([{ uom: 'PCS', conversionFactor: '1.000000', isBase: true, barcode: null }]);
  });

  it('reports a product in another organization as NOT_FOUND', async () => {
    const product = await createProduct(pool, undefined, {
      organizationId: randomUUID(), sku: 'BRG-GET-3', name: 'Rahasia', baseUom: 'PCS', ...meta(),
    });
    const attempt = await getProduct(pool, undefined, { organizationId: randomUUID(), productId: product.productId })
      .catch((error) => error);
    expect((attempt as DomainError).code).toBe('NOT_FOUND');
  });
});

describe('master-data listCustomers', () => {
  const meta = () => ({ actor: { userId: randomUUID(), roles: ['SALES_ADMIN'] }, requestId: randomUUID(), correlationId: randomUUID(), source: 'WEB' as const });

  async function seedCustomer(organizationId: string, name: string, phone?: string) {
    return createCustomer(pool, { organizationId, name, ...(phone ? { phone } : {}), ...meta() });
  }

  it('pages customers and reports the total, without another organization appearing', async () => {
    const organizationId = randomUUID();
    for (let index = 0; index < 5; index += 1) await seedCustomer(organizationId, `Toko ${index}`);
    await seedCustomer(randomUUID(), 'Toko Orang Lain');

    const first = await listCustomers(pool, undefined, { organizationId, pageSize: 2, page: 1 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(first.items.every((item) => item.name.startsWith('Toko'))).toBe(true);

    const last = await listCustomers(pool, undefined, { organizationId, pageSize: 2, page: 3 });
    expect(last.items).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it('searches by partial code or name and filters by status', async () => {
    const organizationId = randomUUID();
    const target = await seedCustomer(organizationId, 'Toko Makmur Jaya', '081234567890');
    await seedCustomer(organizationId, 'Toko Makmur Abadi');

    const byName = await listCustomers(pool, undefined, { organizationId, query: 'Makmur Jaya' });
    expect(byName.items.map((item) => item.customerId)).toEqual([target.id]);

    const byCode = await listCustomers(pool, undefined, { organizationId, query: target.code });
    expect(byCode.items).toHaveLength(1);

    const pending = await listCustomers(pool, undefined, { organizationId, status: 'PENDING_REVIEW' });
    expect(pending.total).toBe(2);
    const active = await listCustomers(pool, undefined, { organizationId, status: 'ACTIVE' });
    expect(active.total).toBe(0);
  });

  it('sorts only by an allow-listed field and refuses anything else', async () => {
    const organizationId = randomUUID();
    await seedCustomer(organizationId, 'Budi');
    await seedCustomer(organizationId, 'Ani');

    const byName = await listCustomers(pool, undefined, { organizationId, sort: 'name' });
    expect(byName.items.map((item) => item.name)).toEqual(['Ani', 'Budi']);

    const attempt = await listCustomers(pool, undefined, { organizationId, sort: 'phone' as 'name' })
      .catch((error) => error);
    expect((attempt as DomainError).code).toBe('VALIDATION_FAILED');
  });

  it('treats a wildcard typed into the search box as a literal character', async () => {
    const organizationId = randomUUID();
    await seedCustomer(organizationId, 'Toko 100% Pure');
    // The `%` in the name is a literal, so a search for `%` must find exactly that customer and not
    // every row. `_` matches any single character in ILIKE, so a search for it must find nothing.
    expect((await listCustomers(pool, undefined, { organizationId, query: '%' })).total).toBe(1);
    expect((await listCustomers(pool, undefined, { organizationId, query: '_' })).total).toBe(0);
    expect((await listCustomers(pool, undefined, { organizationId, query: '100%' })).total).toBe(1);
  });
});
