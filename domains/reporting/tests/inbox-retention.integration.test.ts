import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS_ARCHIVE_DAYS } from '@pss/platform';
import { deleteExpiredInboxReceipts } from '@pss/reporting';

const databaseName = `pss_inbox_retention_${randomUUID().replaceAll('-', '')}`;
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
  await pool.query(await readFile(
    new URL('../../reporting/infrastructure/database/migrations/0001_delivery_order_read_model.sql', import.meta.url), 'utf8',
  ));
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('PLT-005.R05 inbox retention', () => {
  it('refuses a window shorter than the replay archive, since that would reprocess a replayed event', async () => {
    expect(EVENTS_ARCHIVE_DAYS).toBe(400);
    await expect(deleteExpiredInboxReceipts(pool, EVENTS_ARCHIVE_DAYS - 1)).rejects.toThrow('VALIDATION_FAILED');
    expect(await deleteExpiredInboxReceipts(pool)).toBe(0);
  });

  it('removes only receipts past the archive window', async () => {
    const expired = randomUUID();
    const kept = randomUUID();
    await pool.query(
      `INSERT INTO reporting.inbox_event (consumer_name, event_id, processed_at) VALUES
         ('delivery-status.v1', $1, now() - interval '401 days'),
         ('delivery-status.v1', $2, now() - interval '399 days')`,
      [expired, kept],
    );
    expect(await deleteExpiredInboxReceipts(pool)).toBe(1);
    expect((await pool.query<{ event_id: string }>(
      'SELECT event_id FROM reporting.inbox_event',
    )).rows.map((row) => row.event_id)).toEqual([kept]);
  });
});
