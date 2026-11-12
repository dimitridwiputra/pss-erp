import { createHash, randomUUID } from 'node:crypto';
import type { AuditedTransaction } from '@pss/platform';
import { appendOutboxEvent } from '@pss/platform';
import { ApprovalTypeCodeSchema, DomainError, newEventId } from '@pss/contracts';

export async function requestJournalReversal(transaction: AuditedTransaction, input: {
  organizationId: string; journalId: string; makerId: string; reason: string; requestId: string;
}) {
  const original = (await transaction.client.query<{
    id: string; number: string; status: string; source_type: string; business_date: string;
    period_id: string; source_document_id: string | null; source_document_number: string | null;
    branch_id: string | null;
  }>(
    `SELECT id, number, status, source_type, business_date::text, period_id,
            source_document_id, source_document_number, branch_id
     FROM finance.journal WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [input.journalId, input.organizationId],
  )).rows[0];
  if (!original) throw new DomainError('NOT_FOUND');
  if (!['MANUAL','ADJUSTMENT','OPENING'].includes(original.source_type)) {
    throw new DomainError('SYSTEM_JOURNAL_REVERSAL_FORBIDDEN', ['Buka Dokumen'], [{
      path: 'sourceDocument', code: 'SOURCE_DOCUMENT',
      message: original.source_document_number ?? original.source_document_id ?? original.source_type,
    }]);
  }
  if (original.status === 'REVERSED') throw new DomainError('ALREADY_REVERSED');
  if (original.status !== 'POSTED') throw new DomainError('INVALID_STATE_TRANSITION');
  const sourcePeriod = (await transaction.client.query<{
    code: string; status: string; reopened_at: Date | null;
  }>(
    'SELECT code, status, reopened_at FROM finance.accounting_period WHERE id = $1 FOR UPDATE',
    [original.period_id],
  )).rows[0]!;
  let periodId = original.period_id;
  let businessDate = original.business_date;
  let latePosting = false;
  if (sourcePeriod.status === 'CLOSED') {
    const next = (await transaction.client.query<{ id: string; code: string }>(
      `SELECT id, code FROM finance.accounting_period
       WHERE organization_id = $1 AND status = 'OPEN' AND code > $2
       ORDER BY code LIMIT 1 FOR UPDATE`, [input.organizationId, sourcePeriod.code],
    )).rows[0];
    if (!next) throw new DomainError('INVALID_STATE_TRANSITION');
    periodId = next.id;
    businessDate = `${next.code}-01`;
    latePosting = true;
  } else if (sourcePeriod.status === 'SOFT_CLOSED' && !sourcePeriod.reopened_at) {
    // The closed-period default does not redefine ordinary soft-close policy.
    throw new DomainError('INVALID_STATE_TRANSITION');
  }
  const reversalId = randomUUID();
  const approvalRequestId = randomUUID();
  const number = `RV-${businessDate.slice(0, 7).replace('-', '')}-${reversalId}`;
  const originalLines = (await transaction.client.query<{
    line_number: number; account_code: string; debit: string; credit: string; memo: string | null;
  }>(
    `SELECT line_number, account_code, debit::text, credit::text, memo
     FROM finance.journal_line WHERE journal_id = $1 ORDER BY line_number`, [original.id],
  )).rows;
  await transaction.client.query(
    `INSERT INTO finance.journal
       (id, organization_id, number, period_id, business_date, source_type, status,
        maker_id, approval_request_id, reverses_journal_id, reason, late_posting,
        source_document_id, source_document_number, branch_id)
     VALUES ($1,$2,$3,$4,$5,'REVERSAL','PENDING_APPROVAL',$6,$7,$8,$9,$10,$11,$12,$13)`,
    [reversalId, input.organizationId, number, periodId, businessDate, input.makerId,
      approvalRequestId, original.id, input.reason, latePosting,
      original.source_document_id, original.source_document_number, original.branch_id],
  );
  for (const line of originalLines) {
    await transaction.client.query(
      `INSERT INTO finance.journal_line (journal_id, line_number, account_code, debit, credit, memo)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [reversalId, line.line_number, line.account_code, line.credit, line.debit, line.memo],
    );
  }
  const contextHash = createHash('sha256').update(JSON.stringify({
    originalId: original.id, reversalId, businessDate, latePosting, reason: input.reason, originalLines,
  })).digest('hex');
  await transaction.client.query(
    `INSERT INTO finance.approval_effect
       (request_id, organization_id, approval_type, subject_type, subject_ref,
        subject_version, context_hash, status)
     VALUES ($1,$2,$3,'Journal',$4,1,$5,'PENDING')`,
    [approvalRequestId, input.organizationId, ApprovalTypeCodeSchema.enum.journal_reversal,
      reversalId, contextHash],
  );
  await transaction.appendAuditEntry({
    organizationId: input.organizationId, actor: { userId: input.makerId, roles: [] },
    action: 'JOURNAL_REVERSAL_REQUESTED',
    entity: { domain: 'finance', type: 'Journal', id: reversalId, version: 1 },
    changes: [{ path: 'reversesJournalId', classification: 'INTERNAL', after: original.id }],
    reasonCode: input.reason, requestId: input.requestId, correlationId: input.requestId,
    source: 'API', retentionClass: 'FINANCIAL',
  });
  await appendOutboxEvent(transaction.client, {
    eventId: newEventId(), eventType: 'FINANCE_APPROVAL_SUBMITTED', eventVersion: 1,
    occurredAt: new Date().toISOString(), businessDate, organizationId: input.organizationId,
    ...(original.branch_id ? { branchId: original.branch_id } : {}),
    aggregateType: 'FinanceApprovalEffect', aggregateId: approvalRequestId,
    aggregateVersion: 1, producer: 'finance', actor: { userId: input.makerId, roles: [] },
    correlationId: input.requestId, causationId: input.requestId,
    payload: { requestId: approvalRequestId, type: ApprovalTypeCodeSchema.enum.journal_reversal,
      ownerDomain: 'finance', subjectType: 'Journal', subjectRef: reversalId,
      subjectVersion: 1, requestedBy: input.makerId,
      summary: `Pembalikan jurnal ${original.number}`, scopeType: 'ORGANIZATION',
      scopeId: input.organizationId, contextHash },
  });
  return { reversalJournalId: reversalId, originalJournalId: original.id,
    businessDate, latePosting, status: 'PENDING_APPROVAL' as const, approvalRequestId };
}
