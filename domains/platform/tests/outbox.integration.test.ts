import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendOutboxEvent, dispatchPendingEvents, type PublishableEvent } from '../src/application/outbox';

const databaseName = `pss_outbox_test_${randomUUID().replaceAll('-', '')}`;
const aggregateId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

function event(version: number) {
  return {
    eventId: `0195a843-6abc-7000-8000-${version.toString().padStart(12, '0')}`,
    eventType: 'DELIVERY_ORDER_CLOSED', eventVersion: 1,
    occurredAt: '2026-09-27T00:00:00.000Z', businessDate: '2026-09-27',
    organizationId: randomUUID(), aggregateType: 'DeliveryOrder', aggregateId,
    aggregateVersion: version, producer: 'fulfillment',
    correlationId: 'outbox-integration-correlation', causationId: `command-${version}`,
    payload: { doId: aggregateId },
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
  const migration = await readFile(new URL('../infrastructure/database/migrations/0001_outbox_event.sql', import.meta.url), 'utf8');
  await pool.query(migration);
  await pool.query('CREATE TABLE public.test_mutation (id uuid PRIMARY KEY)');
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('PLT-004 PostgreSQL outbox', () => {
  it('rolls back the event with its owning mutation', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO public.test_mutation (id) VALUES ($1)', [aggregateId]);
      await appendOutboxEvent(client, event(1));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT * FROM platform.outbox_event')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM public.test_mutation')).rowCount).toBe(0);
  });

  it('keeps events pending when transport fails and publishes in aggregate order on retry', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO public.test_mutation (id) VALUES ($1)', [aggregateId]);
      await appendOutboxEvent(client, event(1));
      await appendOutboxEvent(client, event(2));
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await expect(dispatchPendingEvents(pool, { publish: async () => { throw new Error('transport offline'); } }))
      .rejects.toThrow('transport offline');
    expect((await pool.query('SELECT count(*)::int AS count FROM platform.outbox_event WHERE published_at IS NULL')).rows[0].count).toBe(2);

    const delivered: number[] = [];
    expect(await dispatchPendingEvents(pool, {
      publish: async (message: PublishableEvent) => { delivered.push(message.aggregateVersion); },
    })).toBe(2);
    expect(delivered).toEqual([1, 2]);
    expect((await pool.query('SELECT count(*)::int AS count FROM platform.outbox_event WHERE published_at IS NULL')).rows[0].count).toBe(0);
  });

  it('rejects an unregistered payload schema before inserting anything', async () => {
    const client = await pool.connect();
    try {
      await expect(appendOutboxEvent(client, { ...event(3), eventVersion: 2 })).rejects.toThrow('No payload schema registered');
      expect((await pool.query('SELECT count(*)::int AS count FROM platform.outbox_event')).rows[0].count).toBe(2);
    } finally {
      client.release();
    }
  });

  it('retries after a send succeeds but marking dispatched fails', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendOutboxEvent(client, event(3));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const delivered: string[] = [];
    await expect(dispatchPendingEvents(pool, {
      publish: async (message) => {
        delivered.push(message.eventId);
        throw new Error('crash after send');
      },
    })).rejects.toThrow('crash after send');
    expect((await pool.query('SELECT published_at FROM platform.outbox_event WHERE event_id = $1', [event(3).eventId])).rows[0].published_at)
      .toBeNull();
    expect(await dispatchPendingEvents(pool, { publish: async (message) => { delivered.push(message.eventId); } })).toBe(1);
    expect(delivered).toEqual([event(3).eventId, event(3).eventId]);
  });
});
