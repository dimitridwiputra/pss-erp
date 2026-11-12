import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAuditedTransaction } from '@pss/audit';
import { newEventId } from '@pss/contracts';
import { decideApproval, processFinanceApprovalSubmission } from '@pss/platform';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';
import { consumeFinanceApprovalDecision } from '../src/application/consume-approval-decision';
import { createManualJournal, submitManualJournal } from '../src/application/manual-journal';
import { requestJournalReversal } from '../src/application/request-journal-reversal';
import { requestPeriodClose, requestPeriodReopen, softClosePeriod } from '../src/application/period-commands';

const databaseName = `pss_finance_approval_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const makerId = randomUUID();
const approverId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

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
    ('1-1100','Kas','ASSET','DEBIT'),('1-1300','Piutang','ASSET','DEBIT'),
    ('6-9000','Beban','EXPENSE','DEBIT')`);
  await pool.query(`INSERT INTO finance.account_role_mapping (role_code, account_code, effective_from)
    VALUES ('AR_CONTROL','1-1300','2026-01-01')`);
  await pool.query(`INSERT INTO finance.accounting_period (organization_id, code, status) VALUES
    ($1,'2026-10','OPEN'),($1,'2026-11','OPEN')`, [organizationId]);
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

const manualInput = (accountCode = '1-1100') => ({
  organizationId, makerId, requestId: randomUUID(), businessDate: '2026-10-15',
  reason: 'Penyesuaian yang didukung memo',
  lines: [
    { accountCode: '6-9000', debit: '100.00', credit: '0.00', memo: 'Beban' },
    { accountCode, debit: '0.00', credit: '100.00', memo: 'Kas' },
  ],
});

async function createAndSubmit() {
  const draft = await withAuditedTransaction(pool, (transaction) =>
    createManualJournal(transaction, manualInput()));
  const submitted = await withAuditedTransaction(pool, (transaction) =>
    submitManualJournal(transaction, {
      organizationId, journalId: draft.id, makerId, requestId: randomUUID(),
    }));
  const event = (await pool.query<{ envelope: unknown }>(
    `SELECT envelope FROM platform.outbox_event
     WHERE event_type = 'FINANCE_APPROVAL_SUBMITTED' AND aggregate_id = $1`,
    [submitted.approvalRequestId],
  )).rows[0]!.envelope;
  return { draft, submitted, event };
}

async function decide(approvalId: string, permission = 'finance.journal.approve') {
  await processFinanceApprovalSubmission(pool, (await pool.query<{ envelope: unknown }>(
    `SELECT envelope FROM platform.outbox_event
     WHERE event_type = 'FINANCE_APPROVAL_SUBMITTED' AND aggregate_id = $1`, [approvalId],
  )).rows[0]!.envelope);
  await decideApproval(pool, {
    approvalId, organizationId, actorId: approverId, decision: 'APPROVED',
    reason: 'Bukti sesuai', businessDate: '2026-10-15', requestId: randomUUID(),
  }, async (access) => access.actorId === approverId && access.permission === permission);
  return (await pool.query<{ envelope: unknown }>(
    `SELECT envelope FROM platform.outbox_event WHERE event_type = 'APPROVAL_DECIDED'
     AND aggregate_id = $1`, [approvalId],
  )).rows[0]!.envelope;
}

describe('MVP-OD-7/8/9 Finance approval and reversal', () => {
  it('rejects control accounts in manual journals but allows a normal balanced journal', async () => {
    await expect(withAuditedTransaction(pool, (transaction) =>
      createManualJournal(transaction, manualInput('1-1300'))))
      .rejects.toThrow('CONTROL_ACCOUNT_MANUAL_POSTING');
    const normal = await withAuditedTransaction(pool, (transaction) =>
      createManualJournal(transaction, manualInput()));
    expect(normal.status).toBe('DRAFT');
  });

  it('rolls back the pending subject and approval outbox together', async () => {
    const draft = await withAuditedTransaction(pool, (transaction) =>
      createManualJournal(transaction, manualInput()));
    await expect(withAuditedTransaction(pool, async (transaction) => {
      await submitManualJournal(transaction, {
        organizationId, journalId: draft.id, makerId, requestId: randomUUID(),
      });
      throw new Error('Simulated owner transaction failure');
    })).rejects.toThrow('Simulated owner transaction failure');
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.journal WHERE id = $1', [draft.id],
    )).rows[0]!.status).toBe('DRAFT');
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM finance.approval_effect WHERE subject_ref = $1`,
      [draft.id],
    )).rows[0]!.count).toBe(0);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.outbox_event
       WHERE event_type = 'FINANCE_APPROVAL_SUBMITTED' AND envelope->'payload'->>'subjectRef' = $1`,
      [draft.id],
    )).rows[0]!.count).toBe(0);
  });

  it('commits pending subject, correlation, audit and outbox atomically; approval posts once', async () => {
    const { draft, submitted, event } = await createAndSubmit();
    expect((await pool.query<{ status: string; version: number }>(
      'SELECT status, version FROM finance.journal WHERE id = $1', [draft.id],
    )).rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', version: 2 });
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.approval_effect WHERE request_id = $1', [submitted.approvalRequestId],
    )).rows[0]!.status).toBe('PENDING');
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit.audit_entry
       WHERE entity_id = $1 AND action = 'MANUAL_JOURNAL_SUBMITTED'`, [draft.id],
    )).rows[0]!.count).toBe(1);
    await Promise.all([processFinanceApprovalSubmission(pool, event), processFinanceApprovalSubmission(pool, event)]);
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM platform.approval_request WHERE id = $1', [submitted.approvalRequestId],
    )).rows[0]!.count).toBe(1);
    const decisionEvent = await decide(submitted.approvalRequestId);
    await Promise.all([consumeFinanceApprovalDecision(pool, decisionEvent),
      consumeFinanceApprovalDecision(pool, decisionEvent)]);
    expect(await consumeFinanceApprovalDecision(pool, {
      ...(decisionEvent as Record<string, unknown>), eventId: newEventId(),
    })).toMatchObject({ status: 'PROCESSED', value: { status: 'DUPLICATE_REQUEST' } });
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.journal WHERE id = $1', [draft.id],
    )).rows[0]!.status).toBe('POSTED');
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.outbox_event
       WHERE event_type = 'JOURNAL_POSTED' AND aggregate_id = $1`, [draft.id],
    )).rows[0]!.count).toBe(1);
  });

  it('keeps a stale subject version from applying an old decision', async () => {
    const { draft, submitted } = await createAndSubmit();
    const decisionEvent = await decide(submitted.approvalRequestId);
    await pool.query('UPDATE finance.journal SET version = version + 1 WHERE id = $1', [draft.id]);
    expect(await consumeFinanceApprovalDecision(pool, decisionEvent)).toMatchObject({
      status: 'PROCESSED', value: { status: 'STALE' },
    });
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.journal WHERE id = $1', [draft.id],
    )).rows[0]!.status).toBe('PENDING_APPROVAL');
  });

  it('records a decided approval whose Finance effect fails validation', async () => {
    const { draft, submitted } = await createAndSubmit();
    const decisionEvent = await decide(submitted.approvalRequestId);
    await pool.query(`UPDATE finance.account SET active = false WHERE code = '6-9000'`);
    try {
      expect(await consumeFinanceApprovalDecision(pool, decisionEvent)).toMatchObject({
        status: 'PROCESSED', value: { status: 'FAILED', reason: 'ACCOUNT_INACTIVE' },
      });
      expect((await pool.query<{ status: string }>(
        'SELECT status FROM finance.approval_effect WHERE request_id = $1',
        [submitted.approvalRequestId],
      )).rows[0]!.status).toBe('FAILED');
      expect((await pool.query<{ status: string }>(
        'SELECT status FROM finance.journal WHERE id = $1', [draft.id],
      )).rows[0]!.status).toBe('PENDING_APPROVAL');
    } finally {
      await pool.query(`UPDATE finance.account SET active = true WHERE code = '6-9000'`);
    }
  });

  it('retains a rejected reversal and permits a corrected request', async () => {
    const original = await createAndSubmit();
    await consumeFinanceApprovalDecision(pool, await decide(original.submitted.approvalRequestId));
    const first = await withAuditedTransaction(pool, (transaction) => requestJournalReversal(transaction, {
      organizationId, journalId: original.draft.id, makerId, reason: 'Alasan pertama', requestId: randomUUID(),
    }));
    await processFinanceApprovalSubmission(pool, (await pool.query<{ envelope: unknown }>(
      `SELECT envelope FROM platform.outbox_event
       WHERE event_type = 'FINANCE_APPROVAL_SUBMITTED' AND aggregate_id = $1`,
      [first.approvalRequestId],
    )).rows[0]!.envelope);
    await decideApproval(pool, {
      approvalId: first.approvalRequestId, organizationId, actorId: approverId,
      decision: 'REJECTED', reason: 'Perlu koreksi', businessDate: '2026-10-15', requestId: randomUUID(),
    }, async () => true);
    const rejectedEvent = (await pool.query<{ envelope: unknown }>(
      `SELECT envelope FROM platform.outbox_event WHERE event_type = 'APPROVAL_DECIDED'
       AND aggregate_id = $1`, [first.approvalRequestId],
    )).rows[0]!.envelope;
    await consumeFinanceApprovalDecision(pool, rejectedEvent);
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.journal WHERE id = $1', [first.reversalJournalId],
    )).rows[0]!.status).toBe('REJECTED');
    const next = await withAuditedTransaction(pool, (transaction) => requestJournalReversal(transaction, {
      organizationId, journalId: original.draft.id, makerId, reason: 'Alasan diperbaiki', requestId: randomUUID(),
    }));
    expect(next.reversalJournalId).not.toBe(first.reversalJournalId);
  });

  it('uses the original OPEN date, then the next OPEN period after close, for approved reversals', async () => {
    const first = await createAndSubmit();
    const firstDecision = await decide(first.submitted.approvalRequestId);
    await consumeFinanceApprovalDecision(pool, firstDecision);
    const openReversal = await withAuditedTransaction(pool, (transaction) => requestJournalReversal(transaction, {
      organizationId, journalId: first.draft.id, makerId, reason: 'Koreksi pertama', requestId: randomUUID(),
    }));
    expect(openReversal).toMatchObject({ businessDate: '2026-10-15', latePosting: false });
    const openDecision = await decide(openReversal.approvalRequestId);
    await consumeFinanceApprovalDecision(pool, openDecision);
    expect((await pool.query<{ status: string; reversed_by_journal_id: string }>(
      'SELECT status, reversed_by_journal_id FROM finance.journal WHERE id = $1', [first.draft.id],
    )).rows[0]).toMatchObject({ status: 'REVERSED', reversed_by_journal_id: openReversal.reversalJournalId });

    const second = await createAndSubmit();
    const secondDecision = await decide(second.submitted.approvalRequestId);
    await consumeFinanceApprovalDecision(pool, secondDecision);
    await pool.query(`UPDATE finance.accounting_period SET status = 'CLOSED'
      WHERE organization_id = $1 AND code = '2026-10'`, [organizationId]);
    const late = await withAuditedTransaction(pool, (transaction) => requestJournalReversal(transaction, {
      organizationId, journalId: second.draft.id, makerId, reason: 'Koreksi setelah tutup', requestId: randomUUID(),
    }));
    expect(late).toMatchObject({ businessDate: '2026-11-01', latePosting: true });
    const lateDecision = await decide(late.approvalRequestId);
    await consumeFinanceApprovalDecision(pool, lateDecision);
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.journal WHERE id = $1', [late.reversalJournalId],
    )).rows[0]!.status).toBe('POSTED');
  });

  it('forbids every human request to reverse a SYSTEM journal and retains its source reference', async () => {
    const period = (await pool.query<{ id: string }>(
      `SELECT id FROM finance.accounting_period WHERE organization_id = $1 AND code = '2026-11'`,
      [organizationId],
    )).rows[0]!.id;
    const systemId = randomUUID();
    await pool.query(`INSERT INTO finance.journal
      (id, organization_id, number, period_id, business_date, source_type, status,
       source_document_number) VALUES ($1,$2,'SYS',$3,'2026-11-02','INVOICE_ISSUED','DRAFT','INV-123')`,
    [systemId, organizationId, period]);
    await pool.query(`INSERT INTO finance.journal_line
      (journal_id, line_number, account_code, debit, credit) VALUES
      ($1,1,'1-1100',100,0),($1,2,'6-9000',0,100)`, [systemId]);
    await pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [systemId]);
    await expect(withAuditedTransaction(pool, (transaction) => requestJournalReversal(transaction, {
      organizationId, journalId: systemId, makerId, reason: 'Tidak boleh', requestId: randomUUID(),
    }))).rejects.toMatchObject({
      code: 'SYSTEM_JOURNAL_REVERSAL_FORBIDDEN',
      fieldErrors: [{ path: 'sourceDocument', code: 'SOURCE_DOCUMENT', message: 'INV-123' }],
    });
  });

  it('closes and reopens a period only after Platform approval returns to Finance', async () => {
    const periodId = (await pool.query<{ id: string }>(
      `SELECT id FROM finance.accounting_period WHERE organization_id = $1 AND code = '2026-11'`,
      [organizationId],
    )).rows[0]!.id;
    await withAuditedTransaction(pool, (transaction) => softClosePeriod(transaction, {
      organizationId, actorId: makerId, periodId, reason: 'Tutup November', requestId: randomUUID(),
    }));
    const close = await withAuditedTransaction(pool, (transaction) => requestPeriodClose(transaction, {
      organizationId, actorId: makerId, periodId, reason: 'Siap tutup',
      overrideExceptions: false, requestId: randomUUID(),
    }));
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.accounting_period WHERE id = $1', [periodId],
    )).rows[0]!.status).toBe('SOFT_CLOSED');
    const closeDecision = await decide(close.approvalRequestId, 'finance.close.approve');
    await consumeFinanceApprovalDecision(pool, closeDecision);
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM finance.accounting_period WHERE id = $1', [periodId],
    )).rows[0]!.status).toBe('CLOSED');
    const reopen = await withAuditedTransaction(pool, (transaction) => requestPeriodReopen(transaction, {
      organizationId, actorId: makerId, periodId, reason: 'Penyesuaian audit', requestId: randomUUID(),
    }));
    const reopenDecision = await decide(reopen.approvalRequestId, 'finance.period.reopen.approve');
    await consumeFinanceApprovalDecision(pool, reopenDecision);
    expect((await pool.query<{ status: string; reopen_approval_id: string }>(
      'SELECT status, reopen_approval_id FROM finance.accounting_period WHERE id = $1', [periodId],
    )).rows[0]).toMatchObject({ status: 'SOFT_CLOSED', reopen_approval_id: reopen.approvalRequestId });
  });
});
