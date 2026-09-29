import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPickupHandover, releaseFulfillment } from '@pss/fulfillment';
import { listOpenDeadLetters, replayDeadLetter, type PublishableEvent } from '@pss/platform';
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
    '../../domains/platform/infrastructure/database/migrations/0005_event_delivery_reliability.sql',
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

async function deliverOneDeliveryOrder(): Promise<string> {
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
  return released.deliveryOrderId;
}

async function projectedStatus(deliveryOrderId: string): Promise<{ status: string; aggregate_version: number }[]> {
  return (await pool.query<{ status: string; aggregate_version: number }>(
    'SELECT status, aggregate_version FROM reporting.delivery_order_status WHERE delivery_order_id = $1',
    [deliveryOrderId],
  )).rows;
}

async function waitForProjection(deliveryOrderId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await projectedStatus(deliveryOrderId);
    if (rows.length) return rows;
    if (Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function testQueueName(): string {
  return `pss-test-${randomUUID()}`;
}

describe('PLT-004/005 live outbox to BullMQ to reporting inbox', () => {
  it('projects an audited delivery once and tolerates replay', async () => {
    const deliveryOrderId = await deliverOneDeliveryOrder();
    const pipeline = startEventPipeline(
      pool, redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'), testQueueName(),
    );
    try {
      await pipeline.ready();
      expect((await pipeline.tick()).published).toBe(1);
      expect(await waitForProjection(deliveryOrderId)).toEqual([{ status: 'DELIVERED', aggregate_version: 2 }]);
      const event = (await pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM platform.outbox_event WHERE aggregate_id = $1', [deliveryOrderId],
      )).rows[0]!.envelope;
      expect((await projectDeliveredOrder(pool, event)).status).toBe('DUPLICATE');
      expect((await pool.query('SELECT * FROM reporting.inbox_event')).rowCount).toBe(1);
      expect((await pool.query('SELECT * FROM platform.outbox_event WHERE published_at IS NULL')).rowCount).toBe(0);
    } finally {
      await pipeline.close();
    }
  });

  it('PLT-004.AC03/PLT-005.TS02 loses nothing when a worker dies mid-batch and a new one starts', async () => {
    const queueName = testQueueName();
    const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    const deliveryOrderIds = [await deliverOneDeliveryOrder(), await deliverOneDeliveryOrder()];

    // First worker: dispatch both events, then die without draining the queue.
    const firstWorker = startEventPipeline(pool, connection, queueName);
    try {
      await firstWorker.ready();
      expect((await firstWorker.tick()).published).toBe(2);
      expect((await firstWorker.stats()).pending).toBe(0);
    } finally {
      await firstWorker.close();
    }

    // The outbox already recorded both as dispatched, so the restart must not resend them;
    // BullMQ still holds whatever the dead worker had not finished.
    const secondWorker = startEventPipeline(pool, connection, queueName);
    try {
      await secondWorker.ready();
      expect((await secondWorker.tick()).published).toBe(0);
      for (const deliveryOrderId of deliveryOrderIds) {
        expect(await waitForProjection(deliveryOrderId)).toEqual([{ status: 'DELIVERED', aggregate_version: 2 }]);
      }
    } finally {
      await secondWorker.close();
    }

    for (const deliveryOrderId of deliveryOrderIds) {
      expect((await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM reporting.inbox_event i JOIN platform.outbox_event o ON o.event_id = i.event_id WHERE o.aggregate_id = $1',
        [deliveryOrderId],
      )).rows[0]!.count).toBe(1);
    }
    expect((await pool.query('SELECT * FROM platform.outbox_event WHERE published_at IS NULL')).rowCount).toBe(0);
  });

  it('PLT-005.AC04 replays an audited dead letter back through the live pipeline', async () => {
    const queueName = testQueueName();
    const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    const deliveryOrderId = await deliverOneDeliveryOrder();
    const event = (await pool.query<{ envelope: unknown }>(
      'SELECT envelope FROM platform.outbox_event WHERE aggregate_id = $1', [deliveryOrderId],
    )).rows[0]!.envelope as PublishableEvent;

    // A consumer that cannot write its own read model is the permanent-failure case. NOT VALID
    // keeps the rows the earlier tests already projected intact while rejecting new writes.
    await pool.query(`ALTER TABLE reporting.delivery_order_status ADD CONSTRAINT reject_projection
      CHECK (status <> 'DELIVERED') NOT VALID`);
    const failingWorker = startEventPipeline(pool, connection, queueName);
    try {
      await failingWorker.ready();
      expect((await failingWorker.tick()).published).toBe(1);
      const deadline = Date.now() + 20_000;
      let deadLetters = await listOpenDeadLetters(pool, { stage: 'CONSUMER' });
      while (!deadLetters.some((entry) => entry.eventId === event.eventId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        deadLetters = await listOpenDeadLetters(pool, { stage: 'CONSUMER' });
      }
      const deadLetter = deadLetters.find((entry) => entry.eventId === event.eventId)!;
      expect(deadLetter).toMatchObject({ status: 'OPEN', consumerName: 'reporting.delivery-status' });
      expect(deadLetter.attemptCount).toBe(5);
      expect((await pool.query('SELECT * FROM audit.audit_entry WHERE entity_id = $1', [deadLetter.id])).rowCount).toBe(0);

      await pool.query('ALTER TABLE reporting.delivery_order_status DROP CONSTRAINT reject_projection');
      const organizationId = randomUUID();
      const replayed = await replayDeadLetter(pool, {
        deadLetterId: deadLetter.id, organizationId, actorId: randomUUID(),
        requestId: randomUUID(), correlationId: randomUUID(), reason: 'Proyeksi diperbaiki',
      });
      expect(replayed.deadLetter.status).toBe('REPLAYED');
      expect((await pool.query<{ action: string }>(
        `SELECT action FROM audit.audit_entry
         WHERE entity_type = 'EventDeadLetter' AND entity_id = $1 AND action = 'EVENT_DEAD_LETTER_REPLAYED'`,
        [deadLetter.id],
      )).rowCount).toBe(1);

      // Re-delivering the verified envelope projects the aggregate exactly once.
      expect((await projectDeliveredOrder(pool, replayed.envelope)).status).toBe('PROCESSED');
      expect(await projectedStatus(deliveryOrderId)).toEqual([{ status: 'DELIVERED', aggregate_version: 2 }]);
      expect((await projectDeliveredOrder(pool, event)).status).toBe('DUPLICATE');
    } finally {
      await failingWorker.close();
      await pool.query('ALTER TABLE reporting.delivery_order_status DROP CONSTRAINT IF EXISTS reject_projection');
    }
    // The loop above waits up to 20s for the retry budget to be spent, so the harness
    // timeout has to exceed that. At the default 5s this test passed only when it ran
    // alone with a warm queue, and timed out under full-suite load.
  }, 40_000);
});
