import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import { declareCashHandover, recordPayment, verifyCashCustody } from '../src/index';
import { applyAuditMigrations, applyMigrations } from '../../../scripts/apply-migrations.mjs';

const databaseName = `pss_payments_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let pool: pg.Pool;

const organizationId = randomUUID();

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });

  // Each domain's full ordered list; platform supplies the outbox the POS events are written to.
  await applyMigrations(pool, 'platform');
  await applyMigrations(pool, 'payments');

  // Every command audits through @pss/audit's withAuditedTransaction/runAuditedWork, which
  // inserts into audit.audit_entry — so that table must exist here too. The whole audit domain
  // is replayed, not one file: a fixture that applies only 0001 is what made amending a shipped
  // migration look safe (MIG-RISK-AUD-001).
  await applyAuditMigrations(pool);

}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

function recordTunaiPayment(acceptedBy: string, amount: string) {
  return recordPayment(pool, undefined, {
    organizationId,
    channel: 'POS',
    method: 'TUNAI',
    amount,
    referenceType: 'POS_SALE',
    referenceId: randomUUID(),
    acceptedBy,
    customerId: randomUUID(),
    cashLocation: { type: 'POS_SHIFT', id: randomUUID() },
    businessDate: '2026-10-01',
  });
}

async function declareHandover(): Promise<{
  cashCustodyRecordId: string;
  declaredAmount: string;
  collectorId: string;
  paymentIds: string[];
}> {
  const collectorId = randomUUID();
  const paymentA = await recordTunaiPayment(collectorId, '15000.00');
  const paymentB = await recordTunaiPayment(collectorId, '20000.00');
  const declared = await declareCashHandover(pool, undefined, {
    organizationId,
    source: 'POS_SHIFT', sourceId: randomUUID(),
    collectorId,
    paymentIds: [paymentA.paymentId, paymentB.paymentId],
  });
  return { ...declared, collectorId, paymentIds: [paymentA.paymentId, paymentB.paymentId] };
}

describe('PAY-001 recordPayment', () => {
  it('creates a PENDING_VERIFICATION payment and audits it', async () => {
    const acceptedBy = randomUUID();
    const result = await recordTunaiPayment(acceptedBy, '50000.00');
    expect(result.status).toBe('PENDING_VERIFICATION');

    const row = await pool.query(
      `SELECT status, method, amount FROM payments.payment WHERE id = $1`,
      [result.paymentId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'PENDING_VERIFICATION', method: 'TUNAI', amount: '50000.00' });

    const auditEntries = await pool.query(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'PAYMENT_RECEIVED'`,
      [result.paymentId],
    );
    expect(auditEntries.rowCount).toBe(1);
  });
});

describe('CSH-001 declareCashHandover', () => {
  it('sums only TUNAI/PENDING_VERIFICATION payments and links them; a repeat call is idempotent', async () => {
    const collectorId = randomUUID();
    const paymentA = await recordTunaiPayment(collectorId, '10000.00');
    const paymentB = await recordTunaiPayment(collectorId, '25000.50');
    // A non-TUNAI payment for the same collector must never be swept into the sum.
    await recordPayment(pool, undefined, {
      organizationId, channel: 'POS', method: 'QRIS', amount: '5000.00',
      referenceType: 'POS_SHIFT_LINE', referenceId: randomUUID(), acceptedBy: collectorId,
    });

    const declared = await declareCashHandover(pool, undefined, {
      organizationId,
      source: 'POS_SHIFT', sourceId: randomUUID(),
      collectorId,
      paymentIds: [paymentA.paymentId, paymentB.paymentId],
    });
    expect(declared.declaredAmount).toBe('35000.50');

    const links = await pool.query(
      `SELECT payment_id FROM payments.cash_custody_payment WHERE cash_custody_record_id = $1 ORDER BY payment_id`,
      [declared.cashCustodyRecordId],
    );
    expect(links.rows.map((r) => r.payment_id).sort()).toEqual([paymentA.paymentId, paymentB.paymentId].sort());

    const auditEntries = await pool.query(
      `SELECT count(*)::int AS count FROM audit.audit_entry WHERE entity_id = $1 AND action = 'CASH_HANDED_OVER'`,
      [declared.cashCustodyRecordId],
    );
    expect(auditEntries.rows[0].count).toBe(1);

    // A repeat declaration with the exact same paymentIds must return the SAME record.
    const repeat = await declareCashHandover(pool, undefined, {
      organizationId,
      source: 'POS_SHIFT', sourceId: randomUUID(),
      collectorId,
      paymentIds: [paymentA.paymentId, paymentB.paymentId],
    });
    expect(repeat.cashCustodyRecordId).toBe(declared.cashCustodyRecordId);
    expect(repeat.declaredAmount).toBe(declared.declaredAmount);

    const recordCount = await pool.query(
      `SELECT count(*)::int AS count FROM payments.cash_custody_record WHERE id = $1`,
      [declared.cashCustodyRecordId],
    );
    expect(recordCount.rows[0].count).toBe(1);

    const linkCountAfterRepeat = await pool.query(
      `SELECT count(*)::int AS count FROM payments.cash_custody_payment WHERE cash_custody_record_id = $1`,
      [declared.cashCustodyRecordId],
    );
    expect(linkCountAfterRepeat.rows[0].count).toBe(2);

    const auditAfterRepeat = await pool.query(
      `SELECT count(*)::int AS count FROM audit.audit_entry WHERE entity_id = $1 AND action = 'CASH_HANDED_OVER'`,
      [declared.cashCustodyRecordId],
    );
    expect(auditAfterRepeat.rows[0].count).toBe(1);
  });

  it('rejects a paymentId that is not TUNAI/PENDING_VERIFICATION', async () => {
    const collectorId = randomUUID();
    const qrisPayment = await recordPayment(pool, undefined, {
      organizationId, channel: 'POS', method: 'QRIS', amount: '1000.00',
      referenceType: 'POS_SHIFT_LINE', referenceId: randomUUID(), acceptedBy: collectorId,
    });

    const attempt = declareCashHandover(pool, undefined, {
      organizationId,
      source: 'POS_SHIFT', sourceId: randomUUID(),
      collectorId,
      paymentIds: [qrisPayment.paymentId],
    });
    await expect(attempt).rejects.toThrow(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const linkCount = await pool.query(
      `SELECT count(*)::int AS count FROM payments.cash_custody_payment WHERE payment_id = $1`,
      [qrisPayment.paymentId],
    );
    expect(linkCount.rows[0].count).toBe(0);
  });
});

describe('CSH-001 verifyCashCustody', () => {
  it('marks VERIFIED and cascades to linked payments when the count matches', async () => {
    const { cashCustodyRecordId, declaredAmount, paymentIds } = await declareHandover();
    const verifierId = randomUUID();

    const result = await verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: declaredAmount, verifiedBy: verifierId });
    expect(result).toMatchObject({ cashCustodyRecordId, status: 'VERIFIED', variance: '0.00' });

    const record = await pool.query(
      `SELECT status, verified_by FROM payments.cash_custody_record WHERE id = $1`,
      [cashCustodyRecordId],
    );
    expect(record.rows[0]).toMatchObject({ status: 'VERIFIED', verified_by: verifierId });

    const linkedPayments = await pool.query(
      `SELECT status, verified_by, version FROM payments.payment WHERE id = ANY($1::uuid[])`,
      [paymentIds],
    );
    expect(linkedPayments.rowCount).toBe(paymentIds.length);
    for (const row of linkedPayments.rows) {
      expect(row).toMatchObject({ status: 'VERIFIED', verified_by: verifierId, version: 2 });
    }

    const auditEntries = await pool.query(
      `SELECT count(*)::int AS count FROM audit.audit_entry WHERE entity_id = $1 AND action = 'CASH_CUSTODY_VERIFIED'`,
      [cashCustodyRecordId],
    );
    expect(auditEntries.rows[0].count).toBe(1);
  });

  it('marks DISCREPANCY and leaves linked payments untouched when the count differs', async () => {
    const { cashCustodyRecordId, paymentIds } = await declareHandover();
    const verifierId = randomUUID();

    const result = await verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: '1.00', verifiedBy: verifierId });
    expect(result.status).toBe('DISCREPANCY');
    expect(result.variance).toBe('-34999.00');

    const record = await pool.query(`SELECT status FROM payments.cash_custody_record WHERE id = $1`, [cashCustodyRecordId]);
    expect(record.rows[0].status).toBe('DISCREPANCY');

    const linkedPayments = await pool.query(
      `SELECT status, verified_by FROM payments.payment WHERE id = ANY($1::uuid[])`,
      [paymentIds],
    );
    for (const row of linkedPayments.rows) {
      expect(row.status).toBe('PENDING_VERIFICATION');
      expect(row.verified_by).toBeNull();
    }

    const auditEntries = await pool.query(
      `SELECT count(*)::int AS count FROM audit.audit_entry WHERE entity_id = $1 AND action = 'CASH_CUSTODY_DISCREPANCY_RECORDED'`,
      [cashCustodyRecordId],
    );
    expect(auditEntries.rows[0].count).toBe(1);
  });

  it('rejects verification by the same collector who declared the handover (SOD-06)', async () => {
    const { cashCustodyRecordId, declaredAmount, collectorId } = await declareHandover();

    const attempt = verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: declaredAmount, verifiedBy: collectorId });
    await expect(attempt).rejects.toThrow(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: 'SEGREGATION_OF_DUTIES' });

    const record = await pool.query(`SELECT status FROM payments.cash_custody_record WHERE id = $1`, [cashCustodyRecordId]);
    expect(record.rows[0].status).toBe('DECLARED');
  });

  it('rejects a second verification attempt on an already-verified record', async () => {
    const { cashCustodyRecordId, declaredAmount } = await declareHandover();
    await verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: declaredAmount, verifiedBy: randomUUID() });

    const attempt = verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: declaredAmount, verifiedBy: randomUUID() });
    await expect(attempt).rejects.toThrow(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: 'CUSTODY_ALREADY_VERIFIED' });
  });
});

describe('MVP-OD-9 cash variance at verification, and CASH_CUSTODY_VERIFIED', () => {
  async function outbox(aggregateId: string) {
    const rows = await pool.query<{ envelope: { payload: Record<string, unknown> } }>(
      "SELECT envelope FROM platform.outbox_event WHERE aggregate_id = $1 AND event_type = 'CASH_CUSTODY_VERIFIED'", [aggregateId],
    );
    return rows.rows.map((row) => row.envelope.payload);
  }

  it('verifies a matching count and publishes the event once, from the stored record', async () => {
    const { cashCustodyRecordId, declaredAmount } = await declareHandover();
    const verifierId = randomUUID();
    await verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: declaredAmount, verifiedBy: verifierId, businessDate: '2026-10-01' });
    await expect(verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: declaredAmount, verifiedBy: verifierId }))
      .rejects.toMatchObject({ code: 'CUSTODY_ALREADY_VERIFIED' });
    const events = await outbox(cashCustodyRecordId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ declaredAmount, countedAmount: declaredAmount, varianceAmount: '0.00', verifiedBy: verifierId, sourceType: 'POS_SHIFT', businessDate: '2026-10-01' });
  });

  it('verifies a short count when a registered CSH reason is given, carrying the signed variance', async () => {
    const { cashCustodyRecordId, paymentIds } = await declareHandover();
    const result = await verifyCashCustody(pool, undefined, {
      cashCustodyRecordId, countedAmount: '1.00', verifiedBy: randomUUID(), reasonCode: 'RC-CSH-COUNT_SHORT',
    });
    expect(result.status).toBe('VERIFIED');
    const record = await pool.query<{ reason_code: string; status: string }>('SELECT reason_code, status FROM payments.cash_custody_record WHERE id = $1', [cashCustodyRecordId]);
    expect(record.rows[0]).toEqual({ reason_code: 'RC-CSH-COUNT_SHORT', status: 'VERIFIED' });
    const payments = await pool.query<{ status: string }>('SELECT status FROM payments.payment WHERE id = ANY($1::uuid[])', [paymentIds]);
    expect(payments.rows.every((row) => row.status === 'VERIFIED')).toBe(true);
    const [event] = await outbox(cashCustodyRecordId);
    expect(event?.varianceAmount).toMatch(/^-\d+\.\d{2}$/);
  });

  it('refuses a reason code that is not a registered CSH code', async () => {
    const { cashCustodyRecordId } = await declareHandover();
    await expect(verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: '1.00', verifiedBy: randomUUID(), reasonCode: 'RC-POS-OTHER' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await outbox(cashCustodyRecordId)).toEqual([]);
  });

  it('publishes nothing for a discrepancy left to CSH-002', async () => {
    const { cashCustodyRecordId } = await declareHandover();
    const result = await verifyCashCustody(pool, undefined, { cashCustodyRecordId, countedAmount: '1.00', verifiedBy: randomUUID() });
    expect(result.status).toBe('DISCREPANCY');
    expect(await outbox(cashCustodyRecordId)).toEqual([]);
  });
});
