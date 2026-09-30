import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory, type INestApplication } from '@nestjs/core';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemExceptionFilter } from '@pss/http';
import { registerPosTerminal } from '@pss/pos';
import { IdentityService } from '../src/identity.controller';
import { PosController, PosService } from '../src/pos.controller';
import { CounterBackofficeController, CounterBackofficeService } from '../src/counter-backoffice.controller';
import { applyAuditMigrations, applyMigrations } from '../../../scripts/apply-migrations.mjs';

@Module({ controllers: [PosController, CounterBackofficeController], providers: [IdentityService, PosService, CounterBackofficeService] })
class PosTestModule {}

const databaseName = `pss_pos_api_test_${randomUUID().replaceAll('-', '')}`;
const issuer = 'http://localhost/realms/pss-test';
const audience = 'pss-api';

const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const warehouseA = randomUUID();
const warehouseB = randomUUID();
const warehouseX = randomUUID();
const barcode = `BC-${randomUUID().slice(0, 8)}`;

// One subject per negative case, each with exactly the assignment the case needs.
const users = {
  cashierA: { id: randomUUID(), org: organizationId, role: 'POS_CASHIER', scopeType: 'WAREHOUSE', scopeId: warehouseA },
  cashierA2: { id: randomUUID(), org: organizationId, role: 'POS_CASHIER', scopeType: 'WAREHOUSE', scopeId: warehouseA },
  cashierB: { id: randomUUID(), org: organizationId, role: 'POS_CASHIER', scopeType: 'WAREHOUSE', scopeId: warehouseB },
  gudangA: { id: randomUUID(), org: organizationId, role: 'WAREHOUSE_ADMIN', scopeType: 'WAREHOUSE', scopeId: warehouseA },
  gudangB: { id: randomUUID(), org: organizationId, role: 'WAREHOUSE_ADMIN', scopeType: 'WAREHOUSE', scopeId: warehouseB },
  keuangan: { id: randomUUID(), org: organizationId, role: 'CASHIER', scopeType: 'BRANCH', scopeId: branchA },
  keuanganB: { id: randomUUID(), org: organizationId, role: 'CASHIER', scopeType: 'BRANCH', scopeId: branchB },
  adminA: { id: randomUUID(), org: organizationId, role: 'POS_SUPERVISOR', scopeType: 'WAREHOUSE', scopeId: warehouseA },
  supervisorB: { id: randomUUID(), org: organizationId, role: 'POS_SUPERVISOR', scopeType: 'WAREHOUSE', scopeId: warehouseB },
  noRole: { id: randomUUID(), org: organizationId, role: null, scopeType: null, scopeId: null },
  foreign: { id: randomUUID(), org: otherOrganizationId, role: 'POS_CASHIER', scopeType: 'WAREHOUSE', scopeId: warehouseX },
} as const;
type Subject = keyof typeof users;

let admin: pg.Client;
let pool: pg.Pool;
let app: INestApplication;
let baseUrl: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let publicJwk: JWK;
let terminalA: string;
let terminalA2: string;
let terminalB: string;
let terminalX: string;

async function token(subject: Subject): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'pos-test-key' })
    .setIssuer(issuer).setAudience(audience).setSubject(`${subject}-subject`)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

interface CallOptions { as?: Subject; body?: unknown; key?: string | null }

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.as) headers.authorization = `Bearer ${await token(options.as)}`;
  if (method !== 'GET' && options.key !== null) headers['idempotency-key'] = options.key ?? randomUUID();
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, ...(method === 'GET' ? {} : { body: options.body === undefined ? '{}' : JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function openShift(as: Subject, terminalId: string, openingFloat = '500000.00') {
  const response = await call('POST', '/pos/shifts', { as, body: { terminalId, openingFloat } });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as string;
}

async function saleWithLine(as: Subject, shiftId: string, qty = '2') {
  const sale = await call('POST', '/pos/sales', { as, body: { shiftId } });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  const line = await call('POST', `/pos/sales/${sale.body.id as string}/lines`, { as, body: { barcode, qty } });
  expect(line.status, JSON.stringify(line.body)).toBe(201);
  return { saleId: sale.body.id as string, lineId: line.body.id as string };
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
  for (const domain of ['identity', 'platform', 'master-data', 'commercial', 'inventory', 'orders', 'fulfillment', 'invoicing', 'payments', 'pos']) {
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

  // MVP_PLAN §7: the back-office admin also prints invoice copies (BIL-001, SALES_ADMIN at the branch).
  await pool.query(
    'INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id) VALUES ($1, $2, $3, $4, $5)',
    [randomUUID(), users.adminA.id, 'SALES_ADMIN', 'BRANCH', branchA],
  );

  // A sellable product with a barcode, a KONTER price, and stock in warehouse A only.
  const productId = randomUUID();
  await pool.query(
    `INSERT INTO core.product (id, organization_id, sku, name, base_uom, order_capture, status)
     VALUES ($1, $2, 'SKU-001', 'Indomie Goreng', 'PCS', 'PSS', 'ACTIVE')`, [productId, organizationId],
  );
  await pool.query(`INSERT INTO core.product_uom (id, product_id, uom, conversion_factor, is_base) VALUES ($1, $2, 'KARTON', 40, false)`, [randomUUID(), productId]);
  await pool.query(`INSERT INTO core.product_barcode (id, product_id, uom, barcode) VALUES ($1, $2, 'KARTON', $3)`, [randomUUID(), productId, barcode]);
  const priceListId = randomUUID();
  await pool.query(`INSERT INTO core.price_list (id, organization_id, scope, status, valid_from) VALUES ($1, $2, 'KONTER', 'ACTIVE', '2026-01-01')`, [priceListId, organizationId]);
  await pool.query(`INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price) VALUES ($1, $2, $3, 'KARTON', '118000.00')`, [randomUUID(), priceListId, productId]);
  await pool.query(
    `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved)
     VALUES ($1, $2, $3, $4, 'KARTON', 25, 0)`, [randomUUID(), organizationId, warehouseA, productId],
  );

  const meta = { actor: { roles: [], serviceIdentity: 'test-seed' }, requestId: randomUUID(), correlationId: randomUUID(), source: 'SYSTEM' as const };
  terminalA = (await registerPosTerminal(pool, undefined, { organizationId, branchId: branchA, warehouseId: warehouseA, code: 'KSR-A1', name: 'Konter A1', ...meta })).id;
  terminalA2 = (await registerPosTerminal(pool, undefined, { organizationId, branchId: branchA, warehouseId: warehouseA, code: 'KSR-A2', name: 'Konter A2', ...meta })).id;
  terminalB = (await registerPosTerminal(pool, undefined, { organizationId, branchId: branchB, warehouseId: warehouseB, code: 'KSR-B1', name: 'Konter B1', ...meta })).id;
  terminalX = (await registerPosTerminal(pool, undefined, { organizationId: otherOrganizationId, branchId: randomUUID(), warehouseId: warehouseX, code: 'KSR-X1', name: 'Konter X1', ...meta })).id;

  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'pos-test-key', alg: 'RS256', use: 'sig' };
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
  process.env.PSS_DEMO_POS_ENABLED = 'true';

  app = await NestFactory.create(PosTestModule, { logger: false });
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (jwksServer) await new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
  for (const name of ['DATABASE_URL', 'PSS_OIDC_ISSUER', 'PSS_OIDC_AUDIENCE', 'PSS_OIDC_JWKS_URI', 'PSS_DEMO_POS_ENABLED']) delete process.env[name];
});

describe('POS API: the counter flow over HTTP', () => {
  it('runs shift → sale → tender → receipt → pickup (another user) → close → cash handover', async () => {
    const terminals = await call('GET', '/kasir/terminals', { as: 'cashierA' });
    expect((terminals.body.items as { id: string }[]).map((terminal) => terminal.id).sort()).toEqual([terminalA, terminalA2].sort());

    const shiftId = await openShift('cashierA', terminalA);
    const { saleId, lineId } = await saleWithLine('cashierA', shiftId, '3');

    const updated = await call('PATCH', `/pos/sales/${saleId}/lines/${lineId}`, { as: 'cashierA', body: { qty: '2' } });
    expect(updated.body).toEqual({ total: '236000.00' });

    const checkout = await call('POST', `/pos/sales/${saleId}/checkout`, { as: 'cashierA' });
    expect(checkout.status).toBe(201);
    expect(checkout.body).toMatchObject({ status: 'PENDING_PAYMENT', total: '236000.00' });

    const tender = await call('POST', `/pos/sales/${saleId}/tenders`, { as: 'cashierA', body: { method: 'TUNAI', cashReceived: '250000' } });
    expect(tender.body).toMatchObject({ tender: { amount: '236000.00', cashReceived: '250000.00', changeAmount: '14000.00' }, sale: { status: 'PAID' } });

    const receipt = await call('POST', `/pos/sales/${saleId}/receipt-prints`, { as: 'cashierA', body: {} });
    expect(receipt.body).toMatchObject({ copyNumber: 1, isCopy: false, total: '236000.00', changeAmount: '14000.00' });
    const reprintWithoutReason = await call('POST', `/pos/sales/${saleId}/receipt-prints`, { as: 'cashierA', body: {} });
    expect(reprintWithoutReason.body.code).toBe('VALIDATION_FAILED');
    const reprint = await call('POST', `/pos/sales/${saleId}/receipt-prints`, { as: 'cashierA', body: { reprintReason: 'Kertas macet' } });
    expect(reprint.body).toMatchObject({ copyNumber: 2, isCopy: true });

    const pickups = await call('GET', '/pos/pickups', { as: 'gudangA' });
    expect((pickups.body.items as { saleId: string }[]).map((pickup) => pickup.saleId)).toContain(saleId);
    const otherWarehousePickups = await call('GET', '/pos/pickups', { as: 'gudangB' });
    expect((otherWarehousePickups.body.items as { saleId: string }[]).map((pickup) => pickup.saleId)).not.toContain(saleId);

    const handover = await call('POST', `/pos/sales/${saleId}/pickup-handover`, { as: 'gudangA', body: { receiverName: 'Budi Santoso' } });
    expect(handover.body, JSON.stringify(handover.body)).toMatchObject({ status: 'HANDED_OVER' });

    const closed = await call('POST', `/pos/shifts/${shiftId}/close`, { as: 'cashierA', body: { countedCash: '736000' } });
    expect(closed.body).toMatchObject({ status: 'CLOSED', expectedCash: '736000.00', variance: '0.00' });

    const shiftSaya = await call('GET', '/kasir/shift-saya', { as: 'cashierA' });
    expect(shiftSaya.body.shift).toMatchObject({ id: shiftId, status: 'CLOSED', cashSalesTotal: '236000.00', paidSaleCount: 1 });

    const cash = await call('POST', `/pos/shifts/${shiftId}/cash-handover`, { as: 'cashierA' });
    expect(cash.body).toMatchObject({ declaredAmount: '236000.00', openingFloat: '500000.00' });

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_event WHERE event_type IN ('PAYMENT_RECEIVED', 'INVOICE_ISSUED') ORDER BY created_at`,
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(['PAYMENT_RECEIVED', 'INVOICE_ISSUED']);
  }, 20_000);
});

describe('POS API: negative paths (RBAC-002, PLT-006, NEXT_IMPLEMENTATION_PLAN §2)', () => {
  it('refuses an unauthenticated caller on every kind of route, including cash handover', async () => {
    for (const [method, path] of [['GET', '/kasir/shift-saya'], ['POST', '/pos/shifts'], ['POST', `/pos/shifts/${randomUUID()}/cash-handover`]] as const) {
      const response = await call(method, path, { body: { terminalId: terminalA, openingFloat: '0' } });
      expect({ path, status: response.status, code: response.body.code }).toEqual({ path, status: 401, code: 'UNAUTHENTICATED' });
    }
  });

  it('requires an Idempotency-Key on a mutation', async () => {
    const response = await call('POST', '/pos/shifts', { as: 'cashierA', body: { terminalId: terminalA, openingFloat: '0' }, key: null });
    expect(response.status).toBe(400);
  });

  it('refuses a caller without the POS permission (wrong role, no role)', async () => {
    for (const as of ['keuangan', 'noRole', 'gudangA'] as const) {
      const response = await call('POST', '/pos/shifts', { as, body: { terminalId: terminalA2, openingFloat: '0' } });
      expect({ as, status: response.status, code: response.body.code }).toEqual({ as, status: 403, code: 'PERMISSION_DENIED' });
    }
    expect((await call('GET', '/kasir/shift-saya', { as: 'keuangan' })).body.code).toBe('PERMISSION_DENIED');
  });

  it('refuses a cashier on a terminal in another warehouse or branch', async () => {
    const response = await call('POST', '/pos/shifts', { as: 'cashierB', body: { terminalId: terminalA2, openingFloat: '0' } });
    expect(response.body.code).toBe('PERMISSION_DENIED');
    expect((await call('GET', '/kasir/terminals', { as: 'cashierB' })).body.items).toEqual([expect.objectContaining({ id: terminalB })]);
  });

  it('reports another organization’s terminal, shift and sale as absent', async () => {
    const foreignShift = await openShift('foreign', terminalX);
    expect((await call('POST', '/pos/shifts', { as: 'cashierA', body: { terminalId: terminalX, openingFloat: '0' } })).body.code).toBe('NOT_FOUND');
    expect((await call('POST', '/pos/sales', { as: 'cashierA', body: { shiftId: foreignShift } })).body.code).toBe('NOT_FOUND');
    expect((await call('POST', `/pos/shifts/${foreignShift}/cash-handover`, { as: 'cashierA' })).body.code).toBe('NOT_FOUND');
    const foreignSale = await call('POST', '/pos/sales', { as: 'foreign', body: { shiftId: foreignShift } });
    expect((await call('GET', `/pos/sales/${foreignSale.body.id as string}`, { as: 'cashierA' })).body.code).toBe('NOT_FOUND');
    expect((await call('POST', `/pos/sales/${foreignSale.body.id as string}/lines`, { as: 'cashierA', body: { barcode } })).body.code).toBe('NOT_FOUND');
  });

  it('keeps a cashier to their own shift', async () => {
    const shiftId = await openShift('cashierA2', terminalA2);
    const { saleId } = await saleWithLine('cashierA2', shiftId, '1');
    expect((await call('POST', '/pos/sales', { as: 'cashierA', body: { shiftId } })).body.code).toBe('PERMISSION_DENIED');
    expect((await call('POST', `/pos/sales/${saleId}/lines`, { as: 'cashierA', body: { barcode } })).body.code).toBe('PERMISSION_DENIED');
    expect((await call('POST', `/pos/sales/${saleId}/checkout`, { as: 'cashierA' })).body.code).toBe('PERMISSION_DENIED');
    expect((await call('POST', `/pos/shifts/${shiftId}/close`, { as: 'cashierA', body: { countedCash: '0' } })).body.code).toBe('PERMISSION_DENIED');
    expect((await call('POST', `/pos/shifts/${shiftId}/cash-handover`, { as: 'cashierA' })).body.code).toBe('PERMISSION_DENIED');
    expect((await call('GET', `/pos/sales/${saleId}`, { as: 'cashierA' })).body.code).toBe('NOT_FOUND');
  });

  it('refuses a body that tries to set the organization, price list, cashier or product identity', async () => {
    const shiftId = (await call('GET', '/kasir/shift-saya', { as: 'cashierA2' })).body.shift as { id: string };
    const sale = await call('POST', '/pos/sales', { as: 'cashierA2', body: { shiftId: shiftId.id } });
    for (const body of [
      { barcode, organizationId: otherOrganizationId },
      { barcode, priceListScope: 'GROSIR' },
      { barcode, productId: randomUUID(), sku: 'X', name: 'Barang palsu' },
    ]) {
      const response = await call('POST', `/pos/sales/${sale.body.id as string}/lines`, { as: 'cashierA2', body });
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    const shift = await call('POST', '/pos/shifts', { as: 'cashierA', body: { terminalId: terminalA, openingFloat: '0', cashierUserId: users.cashierA2.id } });
    expect(shift.status).toBe(400);
  });

  it('refuses a stale state transition', async () => {
    const shiftId = await openShift('cashierA', terminalA, '0');
    const { saleId } = await saleWithLine('cashierA', shiftId, '1');
    expect((await call('POST', `/pos/sales/${saleId}/tenders`, { as: 'cashierA', body: { method: 'TUNAI', cashReceived: '118000' } })).body.code)
      .toBe('INVALID_STATE_TRANSITION');
    expect((await call('POST', `/pos/sales/${saleId}/checkout`, { as: 'cashierA' })).status).toBe(201);
    expect((await call('POST', `/pos/sales/${saleId}/checkout`, { as: 'cashierA' })).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call('POST', `/pos/sales/${saleId}/lines`, { as: 'cashierA', body: { barcode } })).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call('POST', `/pos/sales/${saleId}/pickup-handover`, { as: 'gudangA', body: { receiverName: 'Ani' } })).body.code).toBe('POS_NOT_PAID');
    expect((await call('POST', `/pos/shifts/${shiftId}/close`, { as: 'cashierA', body: { countedCash: '0' } })).body.code).toBe('POS_SHIFT_HAS_PENDING_SALE');
    const paid = await call('POST', `/pos/sales/${saleId}/tenders`, { as: 'cashierA', body: { method: 'TUNAI', cashReceived: '118000' } });
    expect(paid.body).toMatchObject({ sale: { status: 'PAID' } });
    expect((await call('POST', `/pos/sales/${saleId}/pickup-handover`, { as: 'gudangB', body: { receiverName: 'Ani' } })).body.code).toBe('PERMISSION_DENIED');
  });

  it('replays a retried command once and refuses a reused key with a different body', async () => {
    const shiftSaya = await call('GET', '/kasir/shift-saya', { as: 'cashierA' });
    const shiftId = (shiftSaya.body.shift as { id: string }).id;
    const key = randomUUID();
    const first = await call('POST', '/pos/sales', { as: 'cashierA', body: { shiftId }, key });
    const retry = await call('POST', '/pos/sales', { as: 'cashierA', body: { shiftId }, key });
    expect(retry.body).toEqual(first.body);
    const created = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM pos.pos_sale WHERE id = $1', [first.body.id]);
    expect(created.rows[0]!.count).toBe(1);

    const lineKey = randomUUID();
    const line = await call('POST', `/pos/sales/${first.body.id as string}/lines`, { as: 'cashierA', body: { barcode, qty: '1' }, key: lineKey });
    const lineRetry = await call('POST', `/pos/sales/${first.body.id as string}/lines`, { as: 'cashierA', body: { barcode, qty: '1' }, key: lineKey });
    expect(lineRetry.body).toEqual(line.body);
    const lines = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM pos.pos_sale_line WHERE sale_id = $1', [first.body.id]);
    expect(lines.rows[0]!.count).toBe(1);

    const reused = await call('POST', `/pos/sales/${first.body.id as string}/lines`, { as: 'cashierA', body: { barcode, qty: '2' }, key: lineKey });
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('publishes each economic fact once when a tender or handover is retried', async () => {
    const shiftSaya = await call('GET', '/kasir/shift-saya', { as: 'cashierA' });
    const shiftId = (shiftSaya.body.shift as { id: string }).id;
    const { saleId } = await saleWithLine('cashierA', shiftId, '1');
    await call('POST', `/pos/sales/${saleId}/checkout`, { as: 'cashierA' });

    const tenderKey = randomUUID();
    const tenderBody = { method: 'TUNAI', cashReceived: '120000' };
    const tender = await call('POST', `/pos/sales/${saleId}/tenders`, { as: 'cashierA', body: tenderBody, key: tenderKey });
    expect(await call('POST', `/pos/sales/${saleId}/tenders`, { as: 'cashierA', body: tenderBody, key: tenderKey })).toEqual(tender);

    const handoverKey = randomUUID();
    const handover = await call('POST', `/pos/sales/${saleId}/pickup-handover`, { as: 'gudangA', body: { receiverName: 'Ani' }, key: handoverKey });
    expect(await call('POST', `/pos/sales/${saleId}/pickup-handover`, { as: 'gudangA', body: { receiverName: 'Ani' }, key: handoverKey })).toEqual(handover);
    // A new key is a new request, and the sale's state refuses it.
    expect((await call('POST', `/pos/sales/${saleId}/pickup-handover`, { as: 'gudangA', body: { receiverName: 'Ani' } })).body.code).toBe('POS_ALREADY_HANDED_OVER');

    const payments = await pool.query<{ id: string }>('SELECT id FROM payments.payment WHERE reference_id = $1', [saleId]);
    expect(payments.rows).toHaveLength(1);
    const invoice = await pool.query<{ id: string }>('SELECT invoice_id AS id FROM pos.pos_sale WHERE id = $1', [saleId]);
    const events = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_event WHERE aggregate_id = ANY($1::text[]) ORDER BY created_at',
      [[payments.rows[0]!.id, invoice.rows[0]!.id]],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(['PAYMENT_RECEIVED', 'INVOICE_ISSUED']);
  });

  it('refuses checkout when stock is insufficient and leaves the sale in the cart', async () => {
    const shiftSaya = await call('GET', '/kasir/shift-saya', { as: 'cashierA' });
    const shiftId = (shiftSaya.body.shift as { id: string }).id;
    const { saleId } = await saleWithLine('cashierA', shiftId, '999');
    const response = await call('POST', `/pos/sales/${saleId}/checkout`, { as: 'cashierA' });
    expect(response.body.code).toBe('POS_STOCK_INSUFFICIENT');
    expect((await call('GET', `/pos/sales/${saleId}`, { as: 'cashierA' })).body.status).toBe('CART');
  });

  it('rejects malformed ids and money before touching the database', async () => {
    expect((await call('POST', '/pos/sales/not-a-uuid/checkout', { as: 'cashierA' })).body.code).toBe('VALIDATION_FAILED');
    for (const openingFloat of ['-1', '1.234', '1e5', 1000]) {
      const response = await call('POST', '/pos/shifts', { as: 'cashierA', body: { terminalId: terminalA, openingFloat } });
      expect({ openingFloat, status: response.status }).toEqual({ openingFloat, status: 400 });
    }
  });
});

describe('Counter back office: Penjualan, dashboard, Setoran Kas', () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const salesPath = `/pos/reports/sales?from=${today}&to=${today}`;

  it('lists sales only to pos.report.view, scoped to the viewer warehouse and paginated', async () => {
    const list = await call('GET', `${salesPath}&pageSize=2`, { as: 'adminA' });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 2 });
    expect((list.body.items as unknown[]).length).toBeLessThanOrEqual(2);
    expect(list.body.total as number).toBeGreaterThanOrEqual(2);
    const first = (list.body.items as { terminalCode: string }[])[0];
    expect(first?.terminalCode).toMatch(/^KSR-A/);

    expect((await call('GET', salesPath, { as: 'supervisorB' })).body).toMatchObject({ total: 0, items: [] });
    for (const as of ['cashierA', 'keuangan', 'gudangA', 'foreign'] as const) {
      expect({ as, code: (await call('GET', salesPath, { as })).body.code }).toEqual({ as, code: 'PERMISSION_DENIED' });
    }
    expect((await call('GET', `/pos/reports/sales?from=${today}&to=2000-01-01`, { as: 'adminA' })).body.code).toBe('VALIDATION_FAILED');
    expect((await call('GET', `${salesPath}&status=PAID`, { as: 'adminA' })).body.code).toBe('VALIDATION_FAILED');
  });

  it('shows a sale in scope and hides one outside it; copies are always SALINAN', async () => {
    const items = (await call('GET', salesPath, { as: 'adminA' })).body.items as { saleId: string; status: string }[];
    const detail = await call('GET', `/pos/reports/sales/${items[0]!.saleId}`, { as: 'adminA' });
    expect(detail.body).toMatchObject({ sale: { id: items[0]!.saleId }, terminalName: expect.stringMatching(/^Konter A/) });
    expect((await call('GET', `/pos/reports/sales/${items[0]!.saleId}`, { as: 'supervisorB' })).body.code).toBe('NOT_FOUND');

    const printed = await pool.query<{ sale_id: string }>('SELECT DISTINCT sale_id FROM pos.pos_receipt_print');
    const paid = items.find((item) => printed.rows.some((row) => row.sale_id === item.saleId))!;
    const copy = await call('POST', `/pos/reports/sales/${paid.saleId}/copies`, { as: 'adminA', body: { reason: 'Diminta pelanggan' } });
    expect(copy.body, JSON.stringify(copy.body)).toMatchObject({ isCopy: true });
    // A copy follows an original: a paid sale never printed at the counter cannot get a "copy 1".
    const unprinted = items.find((item) => item.status === 'PAID' && !printed.rows.some((row) => row.sale_id === item.saleId));
    if (unprinted) {
      expect((await call('POST', `/pos/reports/sales/${unprinted.saleId}/copies`, { as: 'adminA', body: { reason: 'x' } })).body.code)
        .toBe('INVALID_STATE_TRANSITION');
    }
    expect((await call('POST', `/pos/reports/sales/${paid.saleId}/copies`, { as: 'adminA', body: {} })).status).toBe(400);
    expect((await call('POST', `/pos/reports/sales/${paid.saleId}/copies`, { as: 'supervisorB', body: { reason: 'x' } })).body.code).toBe('PERMISSION_DENIED');
  });

  it('summarises today for the dashboard: sales paid today and cash not yet counted', async () => {
    const summary = await call('GET', '/pos/reports/summary', { as: 'adminA' });
    expect(summary.body).toMatchObject({ businessDate: today });
    expect(summary.body.saleCount as number).toBeGreaterThanOrEqual(1);
    expect(summary.body.salesTotal).toMatch(/^\d+\.\d{2}$/);
    expect(summary.body.undepositedCash).toMatch(/^\d+\.\d{2}$/);
    expect((await call('GET', '/pos/reports/summary', { as: 'supervisorB' })).body).toMatchObject({ saleCount: 0, salesTotal: '0.00', undepositedCash: '0.00' });
    expect((await call('GET', '/pos/reports/summary', { as: 'cashierA' })).body.code).toBe('PERMISSION_DENIED');
  });

  it('lets the branch finance cashier verify a handover, with a reason for a short count', async () => {
    const pending = await call('GET', '/payments/cash-handovers?status=DECLARED', { as: 'keuangan' });
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    const handover = (pending.body.items as { id: string; collectorName: string; shift: { terminalName: string } | null }[])[0]!;
    expect(handover).toMatchObject({ collectorName: 'cashierA', shift: { terminalName: 'Konter A1' } });

    expect((await call('GET', '/payments/cash-handovers?status=DECLARED', { as: 'keuanganB' })).body).toMatchObject({ total: 0 });
    expect((await call('GET', `/payments/cash-handovers/${handover.id}`, { as: 'keuanganB' })).body.code).toBe('NOT_FOUND');
    for (const [as, code] of [['cashierA', 'PERMISSION_DENIED'], ['adminA', 'PERMISSION_DENIED'], ['foreign', 'NOT_FOUND']] as const) {
      expect({ as, code: (await call('POST', `/payments/cash-handovers/${handover.id}/verify`, { as, body: { countedAmount: '1' } })).body.code })
        .toEqual({ as, code });
    }
    expect((await call('POST', `/payments/cash-handovers/${handover.id}/verify`, { as: 'keuangan', body: { countedAmount: '1000', reasonCode: 'NOT-A-CODE' } })).body.code)
      .toBe('VALIDATION_FAILED');

    const key = randomUUID();
    const verify = { countedAmount: '235000', reasonCode: 'RC-CSH-COUNT_SHORT' };
    const verified = await call('POST', `/payments/cash-handovers/${handover.id}/verify`, { as: 'keuangan', body: verify, key });
    expect(verified.body, JSON.stringify(verified.body)).toMatchObject({
      status: 'VERIFIED', countedAmount: '235000.00', varianceAmount: '-1000.00', reasonCode: 'RC-CSH-COUNT_SHORT', verifierName: 'keuangan',
    });
    expect((await call('POST', `/payments/cash-handovers/${handover.id}/verify`, { as: 'keuangan', body: verify, key })).body).toEqual(verified.body);
    expect((await call('POST', `/payments/cash-handovers/${handover.id}/verify`, { as: 'keuangan', body: verify })).body.code).toBe('CUSTODY_ALREADY_VERIFIED');

    const events = await pool.query<{ payload: { varianceAmount: string } }>(
      "SELECT envelope->'payload' AS payload FROM platform.outbox_event WHERE event_type = 'CASH_CUSTODY_VERIFIED' AND aggregate_id = $1", [handover.id],
    );
    expect(events.rows.map((row) => row.payload.varianceAmount)).toEqual(['-1000.00']);
  });
});
