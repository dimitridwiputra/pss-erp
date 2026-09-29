import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPickupHandover, type ConfirmPickupHandoverInput } from '../src/application/confirm-pickup-handover';
import { releaseFulfillment, type ReleaseFulfillmentInput } from '../src/application/release-fulfillment';

const databaseName = `pss_fulfillment_test_${randomUUID().replaceAll('-', '')}`;
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
  const fulfillmentMigration = await readFile(new URL('../infrastructure/database/migrations/0001_fulfillment.sql', import.meta.url), 'utf8');
  await pool.query(fulfillmentMigration);
  const auditMigration = await readFile(new URL('../../audit/infrastructure/database/migrations/0001_audit_entry.sql', import.meta.url), 'utf8');
  await pool.query(auditMigration);
  const platformMigration = await readFile(new URL('../../platform/infrastructure/database/migrations/0001_outbox_event.sql', import.meta.url), 'utf8');
  await pool.query(platformMigration);
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

function releaseInput(qty: string): ReleaseFulfillmentInput {
  return {
    organizationId: randomUUID(),
    salesOrderId: randomUUID(),
    warehouseId: randomUUID(),
    lines: [{ productId: randomUUID(), uom: 'PCS', qty }],
  };
}

async function releaseSingleLine(qty: string) {
  const released = await releaseFulfillment(pool, undefined, releaseInput(qty));
  const line = await pool.query<{ id: string }>(
    'SELECT id FROM sales.delivery_order_line WHERE delivery_order_id = $1',
    [released.deliveryOrderId],
  );
  const deliveryOrderLineId = line.rows[0]?.id;
  if (!deliveryOrderLineId) throw new Error('Test setup did not create a delivery order line.');
  return { ...released, deliveryOrderLineId };
}

function confirmInput(overrides: Partial<ConfirmPickupHandoverInput> & {
  deliveryOrderId: string;
  deliveryOrderLineId: string;
  qtyHandedOver: string;
}): ConfirmPickupHandoverInput {
  const { deliveryOrderId, deliveryOrderLineId, qtyHandedOver, ...rest } = overrides;
  return {
    deliveryOrderId,
    posSaleStatus: 'PAID',
    actorId: randomUUID(),
    sodCashierNotHandoverEnabled: false,
    lines: [{ deliveryOrderLineId, qtyHandedOver }],
    receiverName: 'Budi Santoso',
    ...rest,
  };
}

describe('FUL customer-pickup handover', () => {
  it('releaseFulfillment creates a PREPARED delivery order with correct lines', async () => {
    const input: ReleaseFulfillmentInput = {
      organizationId: randomUUID(),
      salesOrderId: randomUUID(),
      warehouseId: randomUUID(),
      lines: [
        { productId: randomUUID(), uom: 'PCS', qty: '5.000' },
        { productId: randomUUID(), uom: 'BOX', qty: '2.000' },
      ],
    };
    const result = await releaseFulfillment(pool, undefined, input);
    expect(result.fulfillmentRequestId).toBeTruthy();
    expect(result.deliveryOrderId).toBeTruthy();

    const fulfillmentRequest = await pool.query(
      'SELECT status, sales_order_id, warehouse_id FROM sales.fulfillment_request WHERE id = $1',
      [result.fulfillmentRequestId],
    );
    expect(fulfillmentRequest.rows[0]).toMatchObject({
      status: 'RELEASED',
      sales_order_id: input.salesOrderId,
      warehouse_id: input.warehouseId,
    });

    const deliveryOrder = await pool.query(
      'SELECT status, handover_mode FROM sales.delivery_order WHERE id = $1',
      [result.deliveryOrderId],
    );
    expect(deliveryOrder.rows[0]).toMatchObject({ status: 'PREPARED', handover_mode: 'CUSTOMER_PICKUP' });

    const lines = await pool.query(
      'SELECT uom, qty_ordered, qty_delivered FROM sales.delivery_order_line WHERE delivery_order_id = $1 ORDER BY uom',
      [result.deliveryOrderId],
    );
    expect(lines.rowCount).toBe(2);
    expect(lines.rows.map((row) => row.uom)).toEqual(['BOX', 'PCS']);
    expect(lines.rows.every((row) => Number(row.qty_delivered) === 0)).toBe(true);

    const auditEntry = await pool.query(
      "SELECT action, entity_type FROM audit.audit_entry WHERE entity_id = $1 AND action = 'FULFILLMENT_RELEASED'",
      [result.fulfillmentRequestId],
    );
    expect(auditEntry.rowCount).toBe(1);
  });

  it('confirmPickupHandover with full qty transitions to DELIVERED', async () => {
    const released = await releaseSingleLine('8.000');
    const result = await confirmPickupHandover(pool, confirmInput({
      deliveryOrderId: released.deliveryOrderId,
      deliveryOrderLineId: released.deliveryOrderLineId,
      qtyHandedOver: '8.000',
      receiverName: 'Wati',
    }));
    expect(result).toEqual({ deliveryOrderId: released.deliveryOrderId, status: 'DELIVERED' });

    const deliveryOrder = await pool.query(
      'SELECT status, receiver_name, delivered_at FROM sales.delivery_order WHERE id = $1',
      [released.deliveryOrderId],
    );
    expect(deliveryOrder.rows[0].status).toBe('DELIVERED');
    expect(deliveryOrder.rows[0].receiver_name).toBe('Wati');
    expect(deliveryOrder.rows[0].delivered_at).not.toBeNull();
    const outbox = await pool.query(
      `SELECT event_type, envelope->'payload'->>'doId' AS do_id FROM platform.outbox_event WHERE aggregate_id = $1`,
      [released.deliveryOrderId],
    );
    expect(outbox.rows).toEqual([{ event_type: 'DELIVERY_ORDER_DELIVERED', do_id: released.deliveryOrderId }]);
  });

  it('confirmPickupHandover with partial qty transitions to PARTIALLY_DELIVERED', async () => {
    const released = await releaseSingleLine('8.000');
    const result = await confirmPickupHandover(pool, confirmInput({
      deliveryOrderId: released.deliveryOrderId,
      deliveryOrderLineId: released.deliveryOrderLineId,
      qtyHandedOver: '5.000',
      posSaleStatus: 'CREDIT_APPROVED',
    }));
    expect(result.status).toBe('PARTIALLY_DELIVERED');

    const deliveryOrder = await pool.query('SELECT status FROM sales.delivery_order WHERE id = $1', [released.deliveryOrderId]);
    expect(deliveryOrder.rows[0].status).toBe('PARTIALLY_DELIVERED');
  });

  it('throws POS_NOT_PAID when the sale is not PAID or CREDIT_APPROVED', async () => {
    const released = await releaseSingleLine('3.000');
    await expect(confirmPickupHandover(pool, confirmInput({
      deliveryOrderId: released.deliveryOrderId,
      deliveryOrderLineId: released.deliveryOrderLineId,
      qtyHandedOver: '3.000',
      posSaleStatus: 'PENDING_PAYMENT',
    }))).rejects.toMatchObject({ code: 'POS_NOT_PAID' });

    const deliveryOrder = await pool.query('SELECT status FROM sales.delivery_order WHERE id = $1', [released.deliveryOrderId]);
    expect(deliveryOrder.rows[0].status).toBe('PREPARED');
  });

  it('throws POS_ALREADY_HANDED_OVER on a second confirm attempt against an already-DELIVERED order', async () => {
    const released = await releaseSingleLine('4.000');
    const input = confirmInput({
      deliveryOrderId: released.deliveryOrderId,
      deliveryOrderLineId: released.deliveryOrderLineId,
      qtyHandedOver: '4.000',
    });
    await confirmPickupHandover(pool, input);
    await expect(confirmPickupHandover(pool, input)).rejects.toMatchObject({ code: 'POS_ALREADY_HANDED_OVER' });
  });

  it('throws SEGREGATION_OF_DUTIES when the same actor accepted the tender and the SoD flag is on, but succeeds when it is off', async () => {
    const cashierId = randomUUID();

    const blocked = await releaseSingleLine('2.000');
    await expect(confirmPickupHandover(pool, confirmInput({
      deliveryOrderId: blocked.deliveryOrderId,
      deliveryOrderLineId: blocked.deliveryOrderLineId,
      qtyHandedOver: '2.000',
      actorId: cashierId,
      tenderAcceptedBy: cashierId,
      sodCashierNotHandoverEnabled: true,
    }))).rejects.toMatchObject({ code: 'SEGREGATION_OF_DUTIES' });

    const allowed = await releaseSingleLine('2.000');
    const result = await confirmPickupHandover(pool, confirmInput({
      deliveryOrderId: allowed.deliveryOrderId,
      deliveryOrderLineId: allowed.deliveryOrderLineId,
      qtyHandedOver: '2.000',
      actorId: cashierId,
      tenderAcceptedBy: cashierId,
      sodCashierNotHandoverEnabled: false,
    }));
    expect(result.status).toBe('DELIVERED');
  });
});
