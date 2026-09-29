import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DomainError } from '@pss/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelSalesOrder,
  requestSalesOrder,
  type CancelSalesOrderInput,
  type RequestSalesOrderInput,
} from '../src/index';

const databaseName = `pss_orders_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

function buildRequestInput(overrides: Partial<RequestSalesOrderInput> = {}): RequestSalesOrderInput {
  return {
    organizationId: randomUUID(),
    identityId: randomUUID(),
    branchId: randomUUID(),
    warehouseId: randomUUID(),
    customerId: randomUUID(),
    orderSource: 'COUNTER_SALE',
    sourceApplication: 'pos',
    handoverMode: 'CUSTOMER_PICKUP',
    clientKey: randomUUID(),
    lines: [
      { productId: randomUUID(), uom: 'CTN', qty: '2', unitPrice: '15000.50' },
      { productId: randomUUID(), uom: 'PCS', qty: '3.500', unitPrice: '1000.00' },
    ],
    idempotencyKey: { key: randomUUID(), requestHash: 'a'.repeat(64) },
    actor: { userId: randomUUID(), roles: ['POS_CASHIER'] },
    requestId: randomUUID(),
    correlationId: randomUUID(),
    source: 'API',
    ...overrides,
  };
}

function buildCancelInput(salesOrderId: string, overrides: Partial<CancelSalesOrderInput> = {}): CancelSalesOrderInput {
  return {
    salesOrderId,
    reasonCode: 'CUSTOMER_REQUEST',
    actor: { userId: randomUUID(), roles: ['POS_CASHIER'] },
    requestId: randomUUID(),
    correlationId: randomUUID(),
    source: 'API',
    ...overrides,
  };
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  const ordersMigration = await readFile(new URL('../infrastructure/database/migrations/0001_orders.sql', import.meta.url), 'utf8');
  await pool.query(ordersMigration);
  const auditMigration = await readFile(new URL('../../audit/infrastructure/database/migrations/0001_audit_entry.sql', import.meta.url), 'utf8');
  await pool.query(auditMigration);
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('ORD-000 synchronous request-to-confirm', () => {
  it('confirms a sales order with the server-computed total', async () => {
    const input = buildRequestInput();
    const result = await requestSalesOrder(pool, undefined, input);

    expect(result.replayed).toBe(false);
    expect(result.status).toBe('CONFIRMED');
    // 2 * 15000.50 = 30001.00, 3.500 * 1000.00 = 3500.00 -> total 33501.00
    expect(result.total).toBe('33501.00');

    const lineCount = await pool.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM sales.sales_order_line WHERE sales_order_id = $1',
      [result.salesOrderId],
    );
    expect(Number(lineCount.rows[0].count)).toBe(2);

    const auditCount = await pool.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM audit.audit_entry
       WHERE entity_domain = 'orders' AND entity_type = 'SalesOrder' AND entity_id = $1`,
      [result.salesOrderId],
    );
    expect(Number(auditCount.rows[0].count)).toBe(1);
  });

  it('replays the same order for a repeated clientKey without a duplicate row or audit entry', async () => {
    const input = buildRequestInput();
    const first = await requestSalesOrder(pool, undefined, input);
    const second = await requestSalesOrder(pool, undefined, input);

    expect(second.salesOrderId).toBe(first.salesOrderId);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.total).toBe(first.total);

    const orderCount = await pool.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM sales.sales_order WHERE organization_id = $1 AND client_key = $2',
      [input.organizationId, input.clientKey],
    );
    expect(Number(orderCount.rows[0].count)).toBe(1);

    const auditCount = await pool.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM audit.audit_entry
       WHERE entity_domain = 'orders' AND entity_type = 'SalesOrder' AND entity_id = $1`,
      [first.salesOrderId],
    );
    expect(Number(auditCount.rows[0].count)).toBe(1);
  });

  it('produces exactly one order row for two concurrent calls with the same clientKey', async () => {
    const input = buildRequestInput();

    const [a, b] = await Promise.all([
      requestSalesOrder(pool, undefined, input),
      requestSalesOrder(pool, undefined, input),
    ]);

    expect(a.salesOrderId).toBe(b.salesOrderId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);

    const orderCount = await pool.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM sales.sales_order WHERE organization_id = $1 AND client_key = $2',
      [input.organizationId, input.clientKey],
    );
    expect(Number(orderCount.rows[0].count)).toBe(1);

    const auditCount = await pool.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM audit.audit_entry
       WHERE entity_domain = 'orders' AND entity_type = 'SalesOrder' AND entity_id = $1`,
      [a.salesOrderId],
    );
    expect(Number(auditCount.rows[0].count)).toBe(1);
  });

  it('cancels a non-terminal order but rejects cancelling an already-cancelled order', async () => {
    const created = await requestSalesOrder(pool, undefined, buildRequestInput());

    const cancelled = await cancelSalesOrder(pool, undefined, buildCancelInput(created.salesOrderId));
    expect(cancelled.status).toBe('CANCELLED');

    const status = await pool.query<{ status: string }>(
      'SELECT status FROM sales.sales_order WHERE id = $1',
      [created.salesOrderId],
    );
    expect(status.rows[0].status).toBe('CANCELLED');

    await expect(cancelSalesOrder(pool, undefined, buildCancelInput(created.salesOrderId)))
      .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' } satisfies Partial<DomainError>);
  });
});
