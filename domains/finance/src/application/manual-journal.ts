import { createHash, randomUUID } from 'node:crypto';
import type { FinanceManualJournalInput } from '@pss/contracts';
import { ApprovalTypeCodeSchema, DomainError, newEventId } from '@pss/contracts';
import { appendOutboxEvent, type AuditedTransaction } from '@pss/platform';
import { validateBalancedLines } from '../domain/posting-rule';

export async function createManualJournal(transaction: AuditedTransaction, input: FinanceManualJournalInput & {
  organizationId: string; makerId: string; requestId: string;
}) {
  if (!validateBalancedLines(input.lines)) throw new DomainError('VALIDATION_FAILED');
  const periodCode = input.businessDate.slice(0, 7);
  const period = (await transaction.client.query<{ id: string; status: string }>(
    `SELECT id, status FROM finance.accounting_period
     WHERE organization_id = $1 AND code = $2 FOR UPDATE`, [input.organizationId, periodCode],
  )).rows[0];
  if (!period || period.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');
  const codes = [...new Set(input.lines.map((line) => line.accountCode))];
  const active = (await transaction.client.query<{ code: string }>(
    'SELECT code FROM finance.account WHERE code = ANY($1::text[]) AND active', [codes],
  )).rows;
  if (active.length !== codes.length) throw new DomainError('VALIDATION_FAILED');
  const restricted = (await transaction.client.query<{ account_code: string }>(
    `SELECT DISTINCT mapping.account_code FROM finance.account_role_mapping mapping
     JOIN finance.account_role role ON role.code = mapping.role_code
     WHERE mapping.account_code = ANY($1::text[]) AND role.manual_posting_policy = 'DENY'
       AND mapping.effective_from <= $2::date
       AND (mapping.effective_to IS NULL OR mapping.effective_to > $2::date)`,
    [codes, input.businessDate],
  )).rows;
  if (restricted.length > 0) throw new DomainError('CONTROL_ACCOUNT_MANUAL_POSTING');
  const journalId = randomUUID();
  const number = `JV-${periodCode.replace('-', '')}-${journalId}`;
  await transaction.client.query(
    `INSERT INTO finance.journal
       (id, organization_id, number, period_id, business_date, source_type, status, maker_id, reason)
     VALUES ($1,$2,$3,$4,$5,'MANUAL','DRAFT',$6,$7)`,
    [journalId, input.organizationId, number, period.id, input.businessDate, input.makerId, input.reason],
  );
  for (const [index, line] of input.lines.entries()) {
    await transaction.client.query(
      `INSERT INTO finance.journal_line
         (journal_id, line_number, account_code, debit, credit, memo)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [journalId, index + 1, line.accountCode, line.debit, line.credit, line.memo],
    );
  }
  await transaction.appendAuditEntry({
    organizationId: input.organizationId, actor: { userId: input.makerId, roles: [] },
    action: 'MANUAL_JOURNAL_CREATED', entity: { domain: 'finance', type: 'Journal', id: journalId, version: 1 },
    changes: [{ path: 'status', classification: 'INTERNAL', after: 'DRAFT' }],
    reasonCode: input.reason, requestId: input.requestId, correlationId: input.requestId,
    source: 'API', retentionClass: 'FINANCIAL',
  });
  return { id: journalId, number, status: 'DRAFT' as const };
}

export async function submitManualJournal(transaction: AuditedTransaction, input: {
  organizationId: string; journalId: string; makerId: string; requestId: string;
}) {
  const journal = (await transaction.client.query<{
    id: string; number: string; status: string; source_type: string; maker_id: string;
    business_date: string; version: number; reason: string;
  }>(
    `SELECT id, number, status, source_type, maker_id, business_date::text, version, reason
     FROM finance.journal WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [input.journalId, input.organizationId],
  )).rows[0];
  if (!journal) throw new DomainError('NOT_FOUND');
  if (journal.status !== 'DRAFT' || !['MANUAL','ADJUSTMENT'].includes(journal.source_type)) {
    throw new DomainError('INVALID_STATE_TRANSITION');
  }
  if (journal.maker_id !== input.makerId) throw new DomainError('PERMISSION_DENIED');
  const lines = (await transaction.client.query<{
    accountCode: string; debit: string; credit: string; memo: string;
  }>(
    `SELECT account_code AS "accountCode", debit::text, credit::text, COALESCE(memo,'') AS memo
     FROM finance.journal_line WHERE journal_id = $1 ORDER BY line_number`, [journal.id],
  )).rows;
  if (!validateBalancedLines(lines)) throw new DomainError('JOURNAL_NOT_BALANCED');
  const period = (await transaction.client.query<{ status: string }>(
    `SELECT p.status FROM finance.accounting_period p JOIN finance.journal j ON j.period_id = p.id
     WHERE j.id = $1 FOR UPDATE OF p`, [journal.id],
  )).rows[0];
  if (!period || period.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');
  const denied = (await transaction.client.query<{ code: string }>(
    `SELECT DISTINCT line.account_code AS code FROM finance.journal_line line
     JOIN finance.account_role_mapping mapping ON mapping.account_code = line.account_code
     JOIN finance.account_role role ON role.code = mapping.role_code
     WHERE line.journal_id = $1 AND role.manual_posting_policy = 'DENY'
       AND mapping.effective_from <= $2::date
       AND (mapping.effective_to IS NULL OR mapping.effective_to > $2::date)`,
    [journal.id, journal.business_date],
  )).rows;
  if (denied.length > 0) throw new DomainError('CONTROL_ACCOUNT_MANUAL_POSTING');
  const inactive = (await transaction.client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM finance.journal_line line
     JOIN finance.account account ON account.code = line.account_code
     WHERE line.journal_id = $1 AND NOT account.active`, [journal.id],
  )).rows[0]!.count;
  if (inactive > 0) throw new DomainError('VALIDATION_FAILED');
  const approvalRequestId = randomUUID();
  const version = journal.version + 1;
  const contextHash = createHash('sha256')
    .update(JSON.stringify({ journalId: journal.id, version, businessDate: journal.business_date,
      reason: journal.reason, lines })).digest('hex');
  await transaction.client.query(
    `UPDATE finance.journal SET status = 'PENDING_APPROVAL', version = $2,
     approval_request_id = $3, updated_at = now() WHERE id = $1`,
    [journal.id, version, approvalRequestId],
  );
  await transaction.client.query(
    `INSERT INTO finance.approval_effect
       (request_id, organization_id, approval_type, subject_type, subject_ref,
        subject_version, context_hash, status)
     VALUES ($1,$2,$3,'Journal',$4,$5,$6,'PENDING')`,
    [approvalRequestId, input.organizationId, ApprovalTypeCodeSchema.enum.journal,
      journal.id, version, contextHash],
  );
  await transaction.appendAuditEntry({
    organizationId: input.organizationId, actor: { userId: input.makerId, roles: [] },
    action: 'MANUAL_JOURNAL_SUBMITTED',
    entity: { domain: 'finance', type: 'Journal', id: journal.id, version },
    changes: [{ path: 'status', classification: 'INTERNAL', before: 'DRAFT', after: 'PENDING_APPROVAL' }],
    requestId: input.requestId, correlationId: input.requestId, source: 'API', retentionClass: 'FINANCIAL',
  });
  await appendOutboxEvent(transaction.client, {
    eventId: newEventId(), eventType: 'FINANCE_APPROVAL_SUBMITTED', eventVersion: 1,
    occurredAt: new Date().toISOString(), businessDate: journal.business_date,
    organizationId: input.organizationId,
    aggregateType: 'FinanceApprovalEffect', aggregateId: approvalRequestId,
    aggregateVersion: 1, producer: 'finance', actor: { userId: input.makerId, roles: [] },
    correlationId: input.requestId, causationId: input.requestId,
    payload: { requestId: approvalRequestId, type: ApprovalTypeCodeSchema.enum.journal,
      ownerDomain: 'finance', subjectType: 'Journal', subjectRef: journal.id,
      subjectVersion: version, requestedBy: input.makerId, summary: `Jurnal ${journal.number}`,
      scopeType: 'ORGANIZATION', scopeId: input.organizationId, contextHash },
  });
  return { id: journal.id, status: 'PENDING_APPROVAL' as const, approvalRequestId };
}
