import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory, type INestApplication } from '@nestjs/core';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemExceptionFilter } from '@pss/http';
import { IdentityService } from '../src/identity.controller';
import { BackofficePriceListController, BackofficePriceListService } from '../src/backoffice-price-list.controller';
import { BackofficeProductController, BackofficeProductService } from '../src/backoffice-product.controller';
import { BackofficeStockController, BackofficeStockService } from '../src/backoffice-stock.controller';
import { applyAuditMigrations, applyMigrations } from '../../../scripts/apply-migrations.mjs';

@Module({
  controllers: [BackofficeProductController, BackofficePriceListController, BackofficeStockController],
  providers: [IdentityService, BackofficeProductService, BackofficePriceListService, BackofficeStockService],
})
class BackofficeTestModule {}

const databaseName = `pss_backoffice_api_test_${randomUUID().replaceAll('-', '')}`;
const issuer = 'http://localhost/realms/pss-test';
const audience = 'pss-api';

const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const branchA = randomUUID();
const warehouseA = randomUUID();
const warehouseB = randomUUID();

/**
 * One subject per negative case, each holding exactly the assignment that case needs — so a test that
 * expects 403 cannot pass because the subject happened to hold something extra.
 */
const users = {
  /** MVP-OD-32's demo default: MASTER_DATA_STEWARD at the organization. */
  steward: { id: randomUUID(), org: organizationId, role: 'MASTER_DATA_STEWARD', scopeType: 'ORGANIZATION', scopeId: organizationId },
  /** COMMERCIAL_ADMIN at the organization. */
  commercials: { id: randomUUID(), org: organizationId, role: 'COMMERCIAL_ADMIN', scopeType: 'ORGANIZATION', scopeId: organizationId },
  /** WAREHOUSE_ADMIN at warehouse A only: goods receipt and adjustment there, nothing at B. */
  gudangA: { id: randomUUID(), org: organizationId, role: 'WAREHOUSE_ADMIN', scopeType: 'WAREHOUSE', scopeId: warehouseA },
  gudangB: { id: randomUUID(), org: organizationId, role: 'WAREHOUSE_ADMIN', scopeType: 'WAREHOUSE', scopeId: warehouseB },
  /** A cashier holds no back-office permission at all. */
  cashier: { id: randomUUID(), org: organizationId, role: 'POS_CASHIER', scopeType: 'WAREHOUSE', scopeId: warehouseA },
  /** The same steward role, but only at a warehouse — so it must not reach an organization-scoped resource. */
  stewardAtWarehouse: { id: randomUUID(), org: organizationId, role: 'MASTER_DATA_STEWARD', scopeType: 'WAREHOUSE', scopeId: warehouseA },
  noRole: { id: randomUUID(), org: organizationId, role: null, scopeType: null, scopeId: null },
  foreign: { id: randomUUID(), org: otherOrganizationId, role: 'MASTER_DATA_STEWARD', scopeType: 'ORGANIZATION', scopeId: otherOrganizationId },
} as const;
type Subject = keyof typeof users;

let admin: pg.Client;
let pool: pg.Pool;
let app: INestApplication;
let baseUrl: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let publicJwk: JWK;

let productId: string;
let otherProductId: string;
let foreignProductId: string;

async function token(subject: Subject): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'backoffice-test-key' })
    .setIssuer(issuer).setAudience(audience).setSubject(`${subject}-subject`)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

interface CallOptions { as?: Subject; body?: unknown; key?: string | null; auth?: string | null }

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.auth !== null) {
    headers.authorization = `Bearer ${options.auth ?? (options.as ? await token(options.as) : 'not-a-real-token')}`;
  }
  if (method !== 'GET' && options.key !== null) headers['idempotency-key'] = options.key ?? randomUUID();
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, ...(method === 'GET' ? {} : { body: options.body === undefined ? '{}' : JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

beforeAll(async () => {
  const baseDatabaseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseDatabaseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString(), max: 10 });

  await applyAuditMigrations(pool);
  for (const domain of ['identity', 'platform', 'master-data', 'commercial', 'inventory']) {
    await applyMigrations(pool, domain);
  }

  for (const [subject, user] of Object.entries(users)) {
    await pool.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, primary_branch_id, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')`,
      [user.id, user.org, `${subject}-subject`, subject, branchA],
    );
    if (user.role) {
      await pool.query(
        'INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), user.id, user.role, user.scopeType, user.scopeId],
      );
    }
  }

  // A product in each organization, so "another organization" cases have something to be refused.
  for (const [id, org, sku] of [[productId = randomUUID(), organizationId, 'SKU-BO-1'], [otherProductId = randomUUID(), organizationId, 'SKU-BO-2']] as const) {
    await pool.query(
      `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status)
       VALUES ($1, $2, $3, 'Barang Uji', 'PCS', 'PSS', 'ACTIVE')`, [id, org, sku],
    );
    await pool.query(
      `INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base) VALUES ($1, $2, 'KARTON', 12, false)`,
      [randomUUID(), id],
    );
  }
  foreignProductId = randomUUID();
  await pool.query(
    `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status)
     VALUES ($1, $2, 'SKU-FOREIGN', 'Barang Milik Orang Lain', 'PCS', 'PSS', 'ACTIVE')`,
    [foreignProductId, otherOrganizationId],
  );
  await pool.query(
    `INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base) VALUES ($1, $2, 'KARTON', 12, false)`,
    [randomUUID(), foreignProductId],
  );
  // Warehouse B is already used by another organization, for the foreign-warehouse case.
  await pool.query(
    `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved)
     VALUES ($1, $2, $3, $4, 'PCS', 5, 0)`,
    [randomUUID(), otherOrganizationId, warehouseB, foreignProductId],
  );

  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'backoffice-test-key', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();
  if (!address || typeof address === 'string') throw new Error('Test JWKS server did not bind.');
  process.env.DATABASE_URL = testUrl.toString();
  process.env.PSS_OIDC_ISSUER = issuer;
  process.env.PSS_OIDC_AUDIENCE = audience;
  process.env.PSS_OIDC_JWKS_URI = `http://127.0.0.1:${address.port}/jwks`;

  app = await NestFactory.create(BackofficeTestModule, { logger: false });
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('back office: Barang (master-data)', () => {
  it('creates a product and answers with its base unit, so the screen needs no second call', async () => {
    const response = await call('POST', '/master-data/products', {
      as: 'steward', body: { sku: 'SKU-BARU-1', name: 'Kopi Kapal Api', baseUom: 'PCS', status: 'ACTIVE' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ sku: 'SKU-BARU-1', status: 'ACTIVE' });
    expect((response.body.units as { uom: string; isBase: boolean }[])[0]).toMatchObject({ uom: 'PCS', isBase: true });
  });

  it('refuses an unauthenticated caller before anything else', async () => {
    const response = await call('GET', '/master-data/products', { auth: null });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('answers a read outside the permission with NOT_FOUND, and a mutation with PERMISSION_DENIED', async () => {
    // The rule is the repository's, not this controller's: a read that is not visible must not confirm
    // that the resource exists, so `authorizeAt` reports absence for a read and refusal for a write.
    for (const path of ['/master-data/products', '/master-data/customers']) {
      const read = await call('GET', path, { as: 'cashier' });
      expect(read.status, path).toBe(404);
      expect(read.body.code, path).toBe('NOT_FOUND');
    }

    const write = await call('POST', '/master-data/products', {
      as: 'cashier', body: { sku: 'SKU-DENIED', name: 'Ditolak', baseUom: 'PCS' },
    });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('PERMISSION_DENIED');
  });

  it('refuses the same role assigned only at a warehouse on an organization-scoped resource', async () => {
    const read = await call('GET', '/master-data/products', { as: 'stewardAtWarehouse' });
    expect(read.status).toBe(404);
    const write = await call('POST', '/master-data/products', {
      as: 'stewardAtWarehouse', body: { sku: 'SKU-SCOPE', name: 'Salah Scope', baseUom: 'PCS' },
    });
    expect(write.status).toBe(403);
  });

  it('requires an Idempotency-Key on every mutation', async () => {
    const response = await call('POST', '/master-data/products', {
      as: 'steward', key: null, body: { sku: 'SKU-NOKEY', name: 'Tanpa Kunci', baseUom: 'PCS' },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('replays a repeated command under the same key instead of creating a second product', async () => {
    const key = randomUUID();
    const body = { sku: 'SKU-REPLAY-1', name: 'Sekali Saja', baseUom: 'PCS' };
    const first = await call('POST', '/master-data/products', { as: 'steward', key, body });
    const second = await call('POST', '/master-data/products', { as: 'steward', key, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.productId).toBe(first.body.productId);

    const rows = await pool.query('SELECT count(*)::int AS count FROM core.product WHERE sku = $1', ['SKU-REPLAY-1']);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('reports a duplicate SKU as a conflict on the sku field, in Indonesian', async () => {
    const response = await call('POST', '/master-data/products', {
      as: 'steward', body: { sku: 'SKU-BO-1', name: 'Kembaran', baseUom: 'PCS' },
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('DUPLICATE_CODE');
    expect(response.body.fieldErrors).toEqual([
      { path: 'sku', code: 'duplicate', message: 'Kode barang SKU-BO-1 sudah dipakai.' },
    ]);
  });

  it('reports a product in another organization as NOT_FOUND, on read and on write', async () => {
    const read = await call('GET', `/master-data/products/${foreignProductId}`, { as: 'steward' });
    expect(read.status).toBe(404);
    expect(read.body.code).toBe('NOT_FOUND');

    const update = await call('PUT', `/master-data/products/${foreignProductId}`, {
      as: 'steward', body: { name: 'Dibajak' },
    });
    expect(update.status).toBe(404);
    expect(update.body.code).toBe('NOT_FOUND');
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const response = await call('POST', '/master-data/products', {
      as: 'steward', body: { sku: 'SKU-X', name: 'X', baseUom: 'PCS', unitPrice: '1000' },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a stale edit instead of overwriting a change the operator never saw', async () => {
    const detail = await call('GET', `/master-data/products/${productId}`, { as: 'steward' });
    const stale = await call('PUT', `/master-data/products/${productId}`, {
      as: 'steward', body: { name: 'Nama Baru', expectedVersion: 99 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_DATA');
    expect((await call('GET', `/master-data/products/${productId}`, { as: 'steward' })).body.name)
      .toBe((detail.body as { name: string }).name);
  });

  it('rejects a sort field that is not allow-listed', async () => {
    const response = await call('GET', '/master-data/products?sort=secret_column', { as: 'steward' });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('never returns another organization\'s products, and paginates its own', async () => {
    await call('POST', '/master-data/products', {
      as: 'steward', body: { sku: 'SKU-PAGE-1', name: 'Halaman Satu', baseUom: 'PCS' },
    });
    const page = await call('GET', '/master-data/products?pageSize=1&sort=sku', { as: 'steward' });
    expect(page.status).toBe(200);
    const items = page.body.items as { sku: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]?.sku).not.toBe('SKU-FOREIGN');
    expect(page.body.hasMore).toBe(true);

    const foreignView = await call('GET', '/master-data/products?sort=sku', { as: 'foreign' });
    expect((foreignView.body.items as { sku: string }[]).every((item) => item.sku === 'SKU-FOREIGN')).toBe(true);
  });

  it('searches by partial SKU and escapes a wildcard typed into the box', async () => {
    const found = await call('GET', '/master-data/products?q=SKU-BO', { as: 'steward' });
    expect((found.body.items as { sku: string }[]).every((item) => item.sku.startsWith('SKU-BO'))).toBe(true);

    const wildcard = await call('GET', '/master-data/products?q=%25', { as: 'steward' });
    expect(wildcard.body.total).toBe(0);
  });

  it('adds a unit and a barcode, then refuses the barcode a second time', async () => {
    const unit = await call('POST', `/master-data/products/${otherProductId}/uoms`, {
      as: 'steward', body: { uom: 'PAKET', conversionFactor: '6' },
    });
    expect(unit.status, JSON.stringify(unit.body)).toBe(201);

    const barcode = `899${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const added = await call('POST', `/master-data/products/${otherProductId}/barcodes`, {
      as: 'steward', body: { uom: 'PAKET', barcode },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const again = await call('POST', `/master-data/products/${productId}/barcodes`, {
      as: 'steward', body: { uom: 'KARTON', barcode },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_CODE');
    expect((again.body.fieldErrors as { message: string }[])[0]?.message).toContain('sudah dipakai barang lain');
  });

  it('refuses a barcode for a unit the product does not sell', async () => {
    const response = await call('POST', `/master-data/products/${productId}/barcodes`, {
      as: 'steward', body: { uom: 'PAKET', barcode: `899${randomUUID().replaceAll('-', '').slice(0, 10)}` },
    });
    expect(response.status).toBe(422);
    expect((response.body.fieldErrors as { path: string }[])[0]?.path).toBe('uom');
  });

  it('refuses a malformed barcode and a zero conversion factor at the boundary', async () => {
    const malformed = await call('POST', `/master-data/products/${productId}/barcodes`, {
      as: 'steward', body: { uom: 'KARTON', barcode: 'abc 123!' },
    });
    expect(malformed.status).toBe(400);

    const zero = await call('POST', `/master-data/products/${productId}/uoms`, {
      as: 'steward', body: { uom: 'NOL', conversionFactor: '0' },
    });
    expect(zero.status).toBe(422);
    expect((zero.body.fieldErrors as { path: string }[])[0]?.path).toBe('conversionFactor');
  });
});

describe('back office: Pelanggan', () => {
  it('lists customers, and refuses a caller with no master-data grant', async () => {
    const ok = await call('GET', '/master-data/customers', { as: 'steward' });
    expect(ok.status).toBe(200);
    expect(ok.body.items).toEqual([]);

    const denied = await call('GET', '/master-data/customers', { as: 'cashier' });
    expect(denied.status).toBe(404);
  });

  it('never returns another organization\'s customers', async () => {
    await pool.query(
      `INSERT INTO core.customer (id, organization_id, code, name, status) VALUES ($1, $2, 'CUS-1', 'TokoSeeder', 'ACTIVE')`,
      [randomUUID(), otherOrganizationId],
    );
    const mine = await call('GET', '/master-data/customers', { as: 'steward' });
    expect(mine.body.total).toBe(0);
    const theirs = await call('GET', '/master-data/customers', { as: 'foreign' });
    expect(theirs.body.total).toBe(1);
  });
});

describe('back office: Harga (commercial)', () => {
  it('creates a draft, prices it, and activates it into a new version', async () => {
    const draft = await call('POST', '/commercial/price-lists', {
      as: 'commercials', body: { scope: 'KONTER', validFrom: '2026-11-01' },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const priceListId = draft.body.priceListId as string;

    const priced = await call('PUT', `/commercial/price-lists/${priceListId}/items`, {
      as: 'commercials', body: { productId, uom: 'KARTON', unitPrice: '125000.00' },
    });
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(priced.body.unitPrice).toBe('125000.00');

    const activated = await call('POST', `/commercial/price-lists/${priceListId}/activation`, { as: 'commercials' });
    expect(activated.status, JSON.stringify(activated.body)).toBe(201);
    expect(activated.body).toMatchObject({ scope: 'KONTER', itemCount: 1 });

    const lists = await call('GET', '/commercial/price-lists?scope=KONTER', { as: 'commercials' });
    expect(lists.body.activePriceListId).toBe(priceListId);
  });

  it('refuses a caller without commercial.price_list.manage, on reads and writes alike', async () => {
    expect((await call('GET', '/commercial/price-lists', { as: 'steward' })).status).toBe(404);
    expect((await call('POST', '/commercial/price-lists', {
      as: 'gudangA', body: { scope: 'KONTER', validFrom: '2026-11-01' },
    })).status).toBe(403);
  });

  it('refuses to edit a list that is already live (COM-001.NC01)', async () => {
    const live = await call('GET', '/commercial/price-lists?scope=KONTER', { as: 'commercials' });
    const activeId = live.body.activePriceListId as string;
    const response = await call('PUT', `/commercial/price-lists/${activeId}/items`, {
      as: 'commercials', body: { productId, uom: 'KARTON', unitPrice: '1.00' },
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((response.body.fieldErrors as { message: string }[])[0]?.message)
      .toBe('Harga yang sudah aktif tidak bisa diubah. Buat versi daftar harga baru.');
  });

  it('refuses to activate an empty draft rather than publishing a list with no prices', async () => {
    const empty = await call('POST', '/commercial/price-lists', {
      as: 'commercials', body: { scope: 'KOSONG', validFrom: '2026-11-01' },
    });
    const response = await call('POST', `/commercial/price-lists/${empty.body.priceListId as string}/activation`, {
      as: 'commercials',
    });
    expect(response.status).toBe(422);
    expect((response.body.fieldErrors as { message: string }[])[0]?.message).toContain('belum punya harga barang');
  });

  it('replays a repeated activation under the same key rather than activating twice', async () => {
    const draft = await call('POST', '/commercial/price-lists', {
      as: 'commercials', body: { scope: 'REPLAY', validFrom: '2026-11-01' },
    });
    const priceListId = draft.body.priceListId as string;
    await call('PUT', `/commercial/price-lists/${priceListId}/items`, {
      as: 'commercials', body: { productId, uom: 'KARTON', unitPrice: '9000.00' },
    });
    const key = randomUUID();
    const first = await call('POST', `/commercial/price-lists/${priceListId}/activation`, { as: 'commercials', key });
    const second = await call('POST', `/commercial/price-lists/${priceListId}/activation`, { as: 'commercials', key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.priceListId).toBe(priceListId);

    // Without the key it is a fresh command, and a list that is no longer a draft is refused.
    const third = await call('POST', `/commercial/price-lists/${priceListId}/activation`, { as: 'commercials' });
    expect(third.status).toBe(409);
  });

  it('labels each price row with the product it prices, joined through master-data', async () => {
    const draft = await call('POST', '/commercial/price-lists', {
      as: 'commercials', body: { scope: 'LABEL', validFrom: '2026-11-01' },
    });
    const priceListId = draft.body.priceListId as string;
    await call('PUT', `/commercial/price-lists/${priceListId}/items`, {
      as: 'commercials', body: { productId, uom: 'KARTON', unitPrice: '15000.00' },
    });

    const items = await call('GET', `/commercial/price-lists/${priceListId}/items`, { as: 'commercials' });
    expect(items.status).toBe(200);
    expect((items.body.items as { product: { sku: string } }[])[0]?.product?.sku).toBe('SKU-BO-1');
  });

  it('reports a price list in another organization as NOT_FOUND', async () => {
    const foreign = await pool.query<{ id: string }>(
      `INSERT INTO core.price_list (id, organization_id, scope, status, valid_from)
       VALUES ($1, $2, 'KONTER', 'DRAFT', '2026-11-01') RETURNING id`,
      [randomUUID(), otherOrganizationId],
    );
    const response = await call('GET', `/commercial/price-lists/${foreign.rows[0]!.id}/items`, { as: 'commercials' });
    expect(response.status).toBe(404);
  });
});

describe('back office: Stok (inventory)', () => {
  it('receives goods with a cost and shows the balance, its average and its value', async () => {
    const receipt = await call('POST', `/inventory/warehouses/${warehouseA}/goods-receipts`, {
      as: 'gudangA',
      body: {
        businessDate: '2026-10-01',
        lines: [{ productId, uom: 'KARTON', qty: '24.000', unitCost: '9750' }],
      },
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect(receipt.body.unvaluedLineCount).toBe(0);

    const balances = await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}&productId=${productId}`, {
      as: 'gudangA',
    });
    expect(balances.status, JSON.stringify(balances.body)).toBe(200);
    expect((balances.body.items as Record<string, unknown>[])[0]).toMatchObject({
      qtyOnHand: '24.000', avgUnitCost: '9750.0000', stockValue: '234000.00',
    });
    expect((balances.body.items as { product: { sku: string } }[])[0]?.product?.sku).toBe('SKU-BO-1');
  });

  it('publishes INVENTORY_RECEIVED with the cost, so the GL has something to post', async () => {
    const events = await pool.query<{ envelope: { payload: Record<string, unknown> } }>(
      `SELECT envelope FROM platform.outbox_event WHERE event_type = 'INVENTORY_RECEIVED'
         AND envelope->'payload'->>'productId' = $1`,
      [productId],
    );
    expect(events.rows[0]?.envelope.payload).toMatchObject({
      unitCost: '9750.0000', totalCost: '234000.00', sourceType: 'GOODS_RECEIPT', businessDate: '2026-10-01',
    });
  });

  it('records an unvalued receipt as unvalued and says so in the answer', async () => {
    const response = await call('POST', `/inventory/warehouses/${warehouseA}/goods-receipts`, {
      as: 'gudangA', body: { lines: [{ productId: otherProductId, uom: 'KARTON', qty: '5.000' }] },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.unvaluedLineCount).toBe(1);

    const balances = await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}&productId=${otherProductId}`, {
      as: 'gudangA',
    });
    expect((balances.body.items as Record<string, unknown>[])[0]).toMatchObject({ avgUnitCost: null, stockValue: null });
  });

  it('refuses a caller with no stock permission, and one scoped to another warehouse', async () => {
    expect((await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}`, { as: 'steward' })).status).toBe(404);
    expect((await call('POST', `/inventory/warehouses/${warehouseB}/goods-receipts`, {
      as: 'gudangA', body: { lines: [{ productId, uom: 'KARTON', qty: '1.000' }] },
    })).status).toBe(403);
  });

  it('refuses an unauthenticated caller and a caller with no role at all', async () => {
    expect((await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}`, { auth: null })).status).toBe(401);
    expect((await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}`, { as: 'noRole' })).status).toBe(404);
  });

  it('refuses a receipt into a warehouse another organization has used (MVP-OD-22)', async () => {
    const response = await call('POST', `/inventory/warehouses/${warehouseB}/goods-receipts`, {
      as: 'gudangB', body: { lines: [{ productId, uom: 'KARTON', qty: '1.000', unitCost: '100' }] },
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('adjusts stock with a reason and publishes a signed cost delta', async () => {
    const reasons = await call('GET', '/inventory/stock-adjustment-reasons', { as: 'gudangA' });
    expect(reasons.status).toBe(200);
    const codes = (reasons.body.items as { code: string }[]).map((reason) => reason.code);
    expect(codes).toContain('RC-INV-DAMAGED');
    // A code is never shown raw (PRD Appendix F.3): every reason carries display text.
    expect((reasons.body.items as { label: string }[]).every((reason) => !reason.label.startsWith('RC-'))).toBe(true);

    const response = await call('POST', `/inventory/warehouses/${warehouseA}/stock-adjustments`, {
      as: 'gudangA',
      body: {
        businessDate: '2026-10-02',
        lines: [{ productId, uom: 'KARTON', qtyDelta: '-2.000', reasonCode: 'RC-INV-DAMAGED' }],
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const events = await pool.query<{ envelope: { payload: Record<string, unknown> } }>(
      `SELECT envelope FROM platform.outbox_event WHERE event_type = 'INVENTORY_ADJUSTED'
         AND envelope->'payload'->>'productId' = $1`,
      [productId],
    );
    expect(events.rows[0]?.envelope.payload).toMatchObject({
      qtyDelta: '-2.000', unitCost: '9750.0000', totalCostDelta: '-19500.00', reasonCode: 'RC-INV-DAMAGED',
    });
  });

  it('refuses an adjustment with a reason that is not in the reference table', async () => {
    const response = await call('POST', `/inventory/warehouses/${warehouseA}/stock-adjustments`, {
      as: 'gudangA', body: { lines: [{ productId, uom: 'KARTON', qtyDelta: '-1.000', reasonCode: 'RUSAK' }] },
    });
    expect(response.status).toBe(422);
    expect((response.body.fieldErrors as { path: string }[])[0]?.path).toBe('lines[0].reasonCode');
  });

  it('refuses a zero adjustment and a negative receipt at the boundary', async () => {
    const zero = await call('POST', `/inventory/warehouses/${warehouseA}/stock-adjustments`, {
      as: 'gudangA', body: { lines: [{ productId, uom: 'KARTON', qtyDelta: '0.000', reasonCode: 'RC-INV-COUNT_VARIANCE' }] },
    });
    // Well formed but not allowed: this is the domain's rule, so it is 422 with a field message, not a
    // request-shape 400.
    expect(zero.status).toBe(422);
    expect((zero.body.fieldErrors as { code: string }[])[0]?.code).toBe('zero');

    const negative = await call('POST', `/inventory/warehouses/${warehouseA}/goods-receipts`, {
      as: 'gudangA', body: { lines: [{ productId, uom: 'KARTON', qty: '-1.000' }] },
    });
    expect(negative.status).toBe(400);
  });

  it('lists the ledger newest first with the reason label joined', async () => {
    const response = await call('GET', `/inventory/stock-movements?warehouseId=${warehouseA}&productId=${productId}`, {
      as: 'gudangA',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const items = response.body.items as { movementType: string; reasonLabel: string | null; product: { sku: string } | null }[];
    expect(items[0]).toMatchObject({ movementType: 'ADJUSTMENT', reasonLabel: 'Barang rusak' });
    expect(items[1]?.movementType).toBe('RECEIVE');
    expect(items[0]?.product?.sku).toBe('SKU-BO-1');
  });

  it('filters low stock by the threshold the caller supplies, not a constant in the query', async () => {
    // The 24-carton product is above 10; the unvalued 5-carton and 3-carton ones are below.
    const low = await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}&maxQty=10`, { as: 'gudangA' });
    expect(low.status, JSON.stringify(low.body)).toBe(200);
    const ids = (low.body.items as { productId: string }[]).map((item) => item.productId);
    expect(ids).toContain(otherProductId);
    expect(ids).not.toContain(productId);

    // A threshold nothing is under returns an empty page rather than an error, which is what a
    // dashboard tile needs when stock is healthy.
    const stricter = await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}&maxQty=1`, { as: 'gudangA' });
    expect(stricter.status, JSON.stringify(stricter.body)).toBe(200);
    expect(stricter.body.items).toEqual([]);
    expect(stricter.body.total).toBe(0);
  });

  it('refuses a missing or malformed warehouse id', async () => {
    expect((await call('GET', '/inventory/stock-balances', { as: 'gudangA' })).status).toBe(422);
    expect((await call('GET', '/inventory/stock-balances?warehouseId=not-a-uuid', { as: 'gudangA' })).status).toBe(422);
  });

  it('requires an Idempotency-Key on the receipt and the adjustment', async () => {
    for (const path of ['goods-receipts', 'stock-adjustments']) {
      const response = await call('POST', `/inventory/warehouses/${warehouseA}/${path}`, { as: 'gudangA', key: null });
      expect(response.status, path).toBe(400);
    }
  });

  it('replays a repeated receipt under the same key instead of receiving the goods twice', async () => {
    const key = randomUUID();
    const body = { lines: [{ productId: otherProductId, uom: 'KARTON', qty: '3.000', unitCost: '500' }] };
    const first = await call('POST', `/inventory/warehouses/${warehouseA}/goods-receipts`, { as: 'gudangA', key, body });
    const second = await call('POST', `/inventory/warehouses/${warehouseA}/goods-receipts`, { as: 'gudangA', key, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.movementIds).toEqual(first.body.movementIds);

    const balance = await call('GET', `/inventory/stock-balances?warehouseId=${warehouseA}&productId=${otherProductId}`, {
      as: 'gudangA',
    });
    // 5 unvalued earlier plus 3 at 500 — the replay added nothing.
    expect((balance.body.items as { qtyOnHand: string }[])[0]?.qtyOnHand).toBe('8.000');
  });
});
