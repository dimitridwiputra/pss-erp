import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withInbox } from '../src/application/inbox';

const databaseName = `pss_inbox_test_${randomUUID().replaceAll('-', '')}`;
const aggregateId = randomUUID();
function eventUuid(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}
const eventId = eventUuid();
const event = {
  eventId,
  eventType: 'DELIVERY_ORDER_CLOSED',
  eventVersion: 1,
  occurredAt: '2026-09-27T00:00:00.000Z',
  businessDate: '2026-09-27',
  organizationId: randomUUID(),
  aggregateType: 'DeliveryOrder',
  aggregateId,
  aggregateVersion: 1,
  producer: 'fulfillment',
  correlationId: 'inbox-integration-correlation',
  causationId: 'close-delivery-order',
  payload: { doId: aggregateId },
};
function consumer(name: string) {
  return {
    reserve: async (client: pg.PoolClient, receiptEventId: string) => {
      const receipt = await client.query(
        `INSERT INTO reporting.inbox_event (consumer_name, event_id)
         VALUES ($1, $2) ON CONFLICT (consumer_name, event_id) DO NOTHING RETURNING event_id`,
        [name, receiptEventId],
      );
      return receipt.rowCount === 1;
    },
  };
}
const reportingConsumer = consumer('reporting.delivery_close');
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
  await pool.query('CREATE SCHEMA reporting');
  await pool.query(`CREATE TABLE reporting.inbox_event (
    consumer_name text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_name, event_id)
  )`);
  await pool.query('CREATE TABLE reporting.test_effect (event_id uuid PRIMARY KEY, delivery_order_id uuid NOT NULL)');
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('PLT-005 transactional inbox foundation', () => {
  it('PLT-005.AC01/TS01 applies one effect for five simultaneous copies', async () => {
    let attempts = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => withInbox(pool, reportingConsumer, event, async (client, message) => {
      attempts += 1;
      await client.query('INSERT INTO reporting.test_effect (event_id, delivery_order_id) VALUES ($1, $2)',
        [message.eventId, message.payload.doId]);
      return message.eventId;
    })));
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'DUPLICATE')).toHaveLength(4);
    expect(attempts).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM reporting.test_effect')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM reporting.inbox_event')).rows[0].count).toBe(1);
  });

  it('PLT-005.AC02/AC05 rolls back the receipt and effect after a handler crash, then retries', async () => {
    const retryEvent = { ...event, eventId: eventUuid() };
    await expect(withInbox(pool, reportingConsumer, retryEvent, async (client, message) => {
      await client.query('INSERT INTO reporting.test_effect (event_id, delivery_order_id) VALUES ($1, $2)',
        [message.eventId, message.payload.doId]);
      throw new Error('worker killed before commit');
    })).rejects.toThrow('worker killed before commit');
    expect((await pool.query('SELECT count(*)::int AS count FROM reporting.inbox_event WHERE event_id = $1', [retryEvent.eventId])).rows[0].count).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM reporting.test_effect WHERE event_id = $1', [retryEvent.eventId])).rows[0].count).toBe(0);

    expect(await withInbox(pool, reportingConsumer, retryEvent, async (client, message) => {
      await client.query('INSERT INTO reporting.test_effect (event_id, delivery_order_id) VALUES ($1, $2)',
        [message.eventId, message.payload.doId]);
      return message.eventId;
    })).toEqual({ status: 'PROCESSED', value: retryEvent.eventId });
  });

  it('keeps receipts separate per consumer', async () => {
    const otherConsumer = consumer('reporting.second_view');
    expect(await withInbox(pool, otherConsumer, event, async () => 'second effect'))
      .toEqual({ status: 'PROCESSED', value: 'second effect' });
    expect((await pool.query('SELECT count(*)::int AS count FROM reporting.inbox_event WHERE event_id = $1', [eventId])).rows[0].count).toBe(2);
  });
});
