import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newEventId } from '@pss/contracts';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';
import { consumeEconomicEvent, retryPostingException } from '../src/application/consume-economic-event';

const databaseName = `pss_finance_consumer_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const warehouseId = randomUUID();
const productId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

function receipt(totalCost: string | null, date = '2026-10-01') {
  const movementId = randomUUID();
  return {
    eventId: newEventId(), eventType: 'INVENTORY_RECEIVED', eventVersion: 1,
    occurredAt: '2026-10-01T06:00:00.000Z', businessDate: date,
    organizationId, aggregateType: 'InventoryMovement', aggregateId: movementId,
    aggregateVersion: 1, producer: 'inventory', correlationId: randomUUID(), causationId: randomUUID(),
    payload: { movementId, warehouseId, productId, uom: 'PCS', qty: '1.000',
      unitCost: totalCost === null ? null : `${totalCost}00`, totalCost,
      sourceType: 'GOODS_RECEIPT', sourceId: randomUUID(), businessDate: date },
  };
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  await applyMigrations(pool, 'audit');
  await applyMigrations(pool, 'platform');
  await applyMigrations(pool, 'finance');
  await pool.query(`INSERT INTO finance.account (code, name, type, normal_balance) VALUES
    ('1-1400','Persediaan Barang Dagang','ASSET','DEBIT'),
    ('2-1150','Barang Diterima Belum Ditagih','LIABILITY','CREDIT')`);
  await pool.query(`INSERT INTO finance.accounting_period (organization_id, code, status)
    VALUES ($1,'2026-10','OPEN'),($1,'2026-09','CLOSED')`, [organizationId]);
  await pool.query(`INSERT INTO finance.posting_rule (event_type, version, effective_from, line_template)
    VALUES ('INVENTORY_RECEIVED',1,'2026-09-01','{"kind":"RECEIPT"}')`);
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('finance economic event consumer', () => {
  it('posts a registered source-domain compensation once and keeps provenance', async () => {
    await pool.query(`INSERT INTO finance.account (code, name, type, normal_balance) VALUES
      ('1-1110','Kas Konter','ASSET','DEBIT'),('1-1300','Piutang','ASSET','DEBIT')`);
    await pool.query(`INSERT INTO finance.posting_rule (event_type, version, effective_from, line_template)
      VALUES ('PAYMENT_RECEIVED',1,'2026-10-01','{"kind":"PAYMENT"}'),
             ('PAYMENT_REVERSED',1,'2026-10-01','{"kind":"COMPENSATE","originalEventType":"PAYMENT_RECEIVED"}')`);
    const paymentId = randomUUID();
    const originalEventId = newEventId();
    const branchId = randomUUID();
    const original = {
      eventId: originalEventId, eventType: 'PAYMENT_RECEIVED', eventVersion: 1,
      occurredAt: '2026-10-02T06:00:00.000Z', businessDate: '2026-10-02',
      organizationId, branchId, aggregateType: 'Payment', aggregateId: paymentId,
      aggregateVersion: 1, producer: 'payments', correlationId: randomUUID(), causationId: randomUUID(),
      payload: { paymentId, method: 'TUNAI', amount: '100.00', currency: 'IDR',
        customerId: randomUUID(), referenceType: 'POS_SALE', referenceId: randomUUID(),
        invoiceId: null, receivedBy: randomUUID(), cashLocationType: 'POS_SHIFT',
        cashLocationId: randomUUID(), businessDate: '2026-10-02' },
    };
    expect(await consumeEconomicEvent(pool, original)).toMatchObject({
      status: 'PROCESSED', value: { status: 'POSTED' },
    });
    const correction = {
      eventId: newEventId(), eventType: 'PAYMENT_REVERSED', eventVersion: 1,
      occurredAt: '2026-10-03T06:00:00.000Z', businessDate: '2026-10-03',
      organizationId, branchId, aggregateType: 'Payment', aggregateId: paymentId,
      aggregateVersion: 2, producer: 'payments', correlationId: original.correlationId,
      causationId: originalEventId,
      payload: { paymentId, originalEventId, reasonCode: 'PAYMENT_CORRECTION', businessDate: '2026-10-03' },
    };
    const results = await Promise.all([consumeEconomicEvent(pool, correction), consumeEconomicEvent(pool, correction)]);
    expect(results.map((result) => result.status).sort()).toEqual(['DUPLICATE', 'PROCESSED']);
    const journals = (await pool.query<{
      id: string; status: string; reverses_journal_id: string | null;
      reversed_by_journal_id: string | null; branch_id: string;
    }>(
      `SELECT id, status, reverses_journal_id, reversed_by_journal_id, branch_id
       FROM finance.journal WHERE source_event_id IN ($1,$2) ORDER BY business_date`,
      [originalEventId, correction.eventId],
    )).rows;
    expect(journals).toHaveLength(2);
    expect(journals[0]).toMatchObject({ status: 'REVERSED', reversed_by_journal_id: journals[1]!.id });
    expect(journals[1]).toMatchObject({ status: 'POSTED', reverses_journal_id: journals[0]!.id,
      branch_id: branchId });
    const lateDuplicate = { ...correction, eventId: newEventId() };
    expect(await consumeEconomicEvent(pool, lateDuplicate)).toMatchObject({
      status: 'PROCESSED', value: { status: 'EXCEPTION', reason: 'CORRECTION_ALREADY_APPLIED' },
    });
  });
  it('deduplicates simultaneous deliveries by inbox and source event id', async () => {
    const event = receipt('100.00');
    const results = await Promise.all([consumeEconomicEvent(pool, event), consumeEconomicEvent(pool, event)]);
    expect(results.map((result) => result.status).sort()).toEqual(['DUPLICATE', 'PROCESSED']);
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM finance.journal WHERE source_event_id = $1', [event.eventId],
    )).rows[0]!.count).toBe(1);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.outbox_event
       WHERE event_type = 'JOURNAL_POSTED' AND envelope->>'causationId' = $1`, [event.eventId],
    )).rows[0]!.count).toBe(1);
    await pool.query('DELETE FROM finance.event_inbox WHERE event_id = $1', [event.eventId]);
    expect(await consumeEconomicEvent(pool, event)).toMatchObject({
      status: 'PROCESSED', value: { status: 'DUPLICATE_JOURNAL' },
    });
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM finance.journal WHERE source_event_id = $1', [event.eventId],
    )).rows[0]!.count).toBe(1);
  });

  it('keeps a closed-period event as an exception and retries after reopening', async () => {
    const event = receipt('40.00', '2026-09-30');
    const first = await consumeEconomicEvent(pool, event);
    expect(first).toMatchObject({ status: 'PROCESSED', value: { status: 'EXCEPTION', reason: 'PERIOD_CLOSED' } });
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM finance.journal WHERE source_event_id = $1', [event.eventId],
    )).rows[0]!.count).toBe(0);
    const exception = (await pool.query<{ id: string }>(
      'SELECT id FROM finance.posting_exception WHERE event_id = $1', [event.eventId],
    )).rows[0]!;
    await pool.query(`UPDATE finance.accounting_period SET status = 'OPEN'
      WHERE organization_id = $1 AND code = '2026-09'`, [organizationId]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await retryPostingException(client, organizationId, exception.id)).toMatchObject({ status: 'POSTED' });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.posting_exception WHERE id = $1', [exception.id],
    )).rows[0]!.status).toBe('RESOLVED');
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM finance.journal WHERE source_event_id = $1', [event.eventId],
    )).rows[0]!.count).toBe(1);
  });

  it('preserves an unvalued receipt in the exception queue', async () => {
    const event = receipt(null);
    const result = await consumeEconomicEvent(pool, event);
    expect(result).toMatchObject({ status: 'PROCESSED', value: { status: 'EXCEPTION', reason: 'UNVALUED_INVENTORY' } });
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM finance.posting_exception WHERE event_id = $1', [event.eventId],
    )).rows[0]!.count).toBe(1);
  });

  it('replays after a transaction dies before commit', async () => {
    const event = receipt('25.00');
    const killedClient = await pool.connect();
    await killedClient.query('BEGIN');
    await killedClient.query('INSERT INTO finance.event_inbox (event_id) VALUES ($1)', [event.eventId]);
    await killedClient.query('ROLLBACK');
    killedClient.release();
    expect(await consumeEconomicEvent(pool, event)).toMatchObject({ status: 'PROCESSED', value: { status: 'POSTED' } });
  });
});
