import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPickupHandover, releaseFulfillment } from '@pss/fulfillment';
import { projectDeliveredOrder } from '@pss/reporting';
import { redisConnectionFromUrl, startEventPipeline } from '../../apps/integration-worker/src/event-pipeline';

const databaseName = `pss_pipeline_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const relativePath of [
    '../../domains/audit/infrastructure/database/migrations/0001_audit_entry.sql',
    '../../domains/platform/infrastructure/database/migrations/0001_outbox_event.sql',
    '../../domains/fulfillment/infrastructure/database/migrations/0001_fulfillment.sql',
    '../../domains/reporting/infrastructure/database/migrations/0001_delivery_order_read_model.sql',
  ]) {
    await pool.query(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
  }
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('PLT-004/005 live outbox to BullMQ to reporting inbox', () => {
  it('projects an audited delivery once and tolerates replay', async () => {
    const organizationId = randomUUID();
    const actorId = randomUUID();
    const productId = randomUUID();
    const released = await releaseFulfillment(pool, undefined, {
      organizationId, salesOrderId: randomUUID(), warehouseId: randomUUID(),
      lines: [{ productId, uom: 'PCS', qty: '2.000' }],
    });
    const line = await pool.query<{ id: string }>(
      'SELECT id FROM sales.delivery_order_line WHERE delivery_order_id = $1', [released.deliveryOrderId],
    );
    await confirmPickupHandover(pool, {
      deliveryOrderId: released.deliveryOrderId,
      posSaleStatus: 'PAID', actorId, sodCashierNotHandoverEnabled: false,
      lines: [{ deliveryOrderLineId: line.rows[0]!.id, qtyHandedOver: '2.000' }],
      receiverName: 'Penerima Uji',
    });

    const pipeline = startEventPipeline(
      pool, redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'),
      `pss-test-${randomUUID()}`,
    );
    try {
      await pipeline.ready();
      expect(await pipeline.tick()).toBe(1);
      let rows: { status: string; aggregate_version: number }[] = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        rows = (await pool.query<{ status: string; aggregate_version: number }>(
          'SELECT status, aggregate_version FROM reporting.delivery_order_status WHERE delivery_order_id = $1',
          [released.deliveryOrderId],
        )).rows;
        if (rows.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(rows).toEqual([{ status: 'DELIVERED', aggregate_version: 2 }]);
      const event = (await pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM platform.outbox_event WHERE aggregate_id = $1', [released.deliveryOrderId],
      )).rows[0]!.envelope;
      expect((await projectDeliveredOrder(pool, event)).status).toBe('DUPLICATE');
      expect((await pool.query('SELECT * FROM reporting.inbox_event')).rowCount).toBe(1);
      expect((await pool.query('SELECT * FROM platform.outbox_event WHERE published_at IS NULL')).rowCount).toBe(0);
    } finally {
      await pipeline.close();
    }
  });
});
