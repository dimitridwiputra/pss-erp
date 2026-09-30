import { createHash, randomUUID } from 'node:crypto';
import type { AuditedTransaction } from '@pss/platform';
import { appendOutboxEvent } from '@pss/platform';
import { ApprovalTypeCodeSchema, DomainError, newEventId } from '@pss/contracts';

interface PeriodCommand {
  organizationId: string;
  actorId: string;
  periodId: string;
  requestId: string;
  reason: string;
}

async function loadPeriod(transaction: AuditedTransaction, command: PeriodCommand) {
  const period = (await transaction.client.query<{ id: string; code: string; status: string }>(
    `SELECT id, code, status FROM finance.accounting_period
     WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [command.periodId, command.organizationId],
  )).rows[0];
  if (!period) throw new DomainError('NOT_FOUND');
  return period;
}

export async function softClosePeriod(transaction: AuditedTransaction, command: PeriodCommand) {
  const period = await loadPeriod(transaction, command);
  if (period.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');
  await transaction.client.query(
    `UPDATE finance.accounting_period SET status = 'SOFT_CLOSED', soft_closed_at = now(),
     soft_closed_by = $2, close_reason = $3, updated_at = now() WHERE id = $1`,
    [period.id, command.actorId, command.reason],
  );
  await transaction.appendAuditEntry({
    organizationId: command.organizationId, actor: { userId: command.actorId, roles: [] },
    action: 'ACCOUNTING_PERIOD_SOFT_CLOSED', entity: { domain: 'finance', type: 'AccountingPeriod', id: period.id, version: 1 },
    changes: [{ path: 'status', classification: 'INTERNAL', before: 'OPEN', after: 'SOFT_CLOSED' }],
    reasonCode: command.reason, requestId: command.requestId, correlationId: command.requestId,
    source: 'API', retentionClass: 'FINANCIAL',
  });
  return { periodId: period.id, periodCode: period.code, status: 'SOFT_CLOSED' as const };
}

export async function closePeriod(transaction: AuditedTransaction,
  command: PeriodCommand & { overrideExceptions: boolean }) {
  const period = await loadPeriod(transaction, command);
  if (period.status !== 'SOFT_CLOSED') throw new DomainError('INVALID_STATE_TRANSITION');
  const pending = (await transaction.client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM finance.posting_exception
     WHERE organization_id = $1 AND left(business_date::text, 7) = $2 AND status <> 'RESOLVED'`,
    [command.organizationId, period.code],
  )).rows[0]!.count;
  if (pending > 0 && !command.overrideExceptions) throw new DomainError('INVALID_STATE_TRANSITION');
  await transaction.client.query(
    `UPDATE finance.accounting_period SET status = 'CLOSED', closed_at = now(),
     closed_by = $2, close_reason = $3, updated_at = now() WHERE id = $1`,
    [period.id, command.actorId, command.reason],
  );
  await transaction.appendAuditEntry({
    organizationId: command.organizationId, actor: { userId: command.actorId, roles: [] },
    action: 'ACCOUNTING_PERIOD_CLOSED', entity: { domain: 'finance', type: 'AccountingPeriod', id: period.id, version: 2 },
    changes: [{ path: 'status', classification: 'INTERNAL', before: 'SOFT_CLOSED', after: 'CLOSED' },
      { path: 'pendingExceptions', classification: 'INTERNAL', after: pending }],
    reasonCode: command.reason, requestId: command.requestId, correlationId: command.requestId,
    source: 'API', retentionClass: 'FINANCIAL',
  });
  const businessDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  await appendOutboxEvent(transaction.client, {
    eventId: newEventId(), eventType: 'ACCOUNTING_PERIOD_CLOSED', eventVersion: 1,
    occurredAt: new Date().toISOString(), businessDate,
    organizationId: command.organizationId, aggregateType: 'AccountingPeriod', aggregateId: period.id,
    aggregateVersion: 1, producer: 'finance', actor: { userId: command.actorId, roles: [] },
    correlationId: command.requestId, causationId: command.requestId,
    payload: { periodId: period.id, periodCode: period.code, closedBy: command.actorId },
  });
  return { periodId: period.id, periodCode: period.code, status: 'CLOSED' as const,
    pendingExceptionsOverridden: command.overrideExceptions ? pending : 0 };
}

/** A closed period stays closed until the shared approval decision returns. */
export async function requestPeriodReopen(transaction: AuditedTransaction, command: PeriodCommand) {
  const period = await loadPeriod(transaction, command);
  if (period.status !== 'CLOSED') throw new DomainError('INVALID_STATE_TRANSITION');
  const reopenRequestId = randomUUID();
  const approvalRequestId = randomUUID();
  const contextHash = createHash('sha256').update(JSON.stringify({
    periodId: period.id, periodCode: period.code, status: period.status, reason: command.reason,
  })).digest('hex');
  await transaction.client.query(
    `INSERT INTO finance.period_reopen_request
       (id, organization_id, period_id, requested_by, reason, status, approval_request_id)
     VALUES ($1,$2,$3,$4,$5,'PENDING_APPROVAL',$6)`,
    [reopenRequestId, command.organizationId, period.id, command.actorId,
      command.reason, approvalRequestId],
  );
  await transaction.client.query(
    `INSERT INTO finance.approval_effect
       (request_id, organization_id, approval_type, subject_type, subject_ref,
        subject_version, context_hash, status)
     VALUES ($1,$2,$3,'PeriodReopenRequest',$4,1,$5,'PENDING')`,
    [approvalRequestId, command.organizationId, ApprovalTypeCodeSchema.enum.period_reopen,
      reopenRequestId, contextHash],
  );
  await transaction.appendAuditEntry({
    organizationId: command.organizationId, actor: { userId: command.actorId, roles: [] },
    action: 'ACCOUNTING_PERIOD_REOPEN_REQUESTED',
    entity: { domain: 'finance', type: 'PeriodReopenRequest', id: reopenRequestId, version: 1 },
    changes: [{ path: 'status', classification: 'INTERNAL', after: 'PENDING_APPROVAL' }],
    reasonCode: command.reason, requestId: command.requestId, correlationId: command.requestId,
    source: 'API', retentionClass: 'FINANCIAL',
  });
  const businessDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  await appendOutboxEvent(transaction.client, {
    eventId: newEventId(), eventType: 'FINANCE_APPROVAL_SUBMITTED', eventVersion: 1,
    occurredAt: new Date().toISOString(), businessDate,
    organizationId: command.organizationId, aggregateType: 'FinanceApprovalEffect',
    aggregateId: approvalRequestId, aggregateVersion: 1, producer: 'finance',
    actor: { userId: command.actorId, roles: [] },
    correlationId: command.requestId, causationId: command.requestId,
    payload: { requestId: approvalRequestId, type: ApprovalTypeCodeSchema.enum.period_reopen,
      ownerDomain: 'finance', subjectType: 'PeriodReopenRequest', subjectRef: reopenRequestId,
      subjectVersion: 1, requestedBy: command.actorId,
      summary: `Buka kembali periode ${period.code}`, scopeType: 'ORGANIZATION',
      scopeId: command.organizationId, contextHash },
  });
  return { periodId: period.id, reopenRequestId, approvalRequestId, status: 'PENDING_APPROVAL' as const };
}

export async function requestPeriodClose(transaction: AuditedTransaction,
  command: PeriodCommand & { overrideExceptions: boolean }) {
  const period = await loadPeriod(transaction, command);
  if (period.status !== 'SOFT_CLOSED') throw new DomainError('INVALID_STATE_TRANSITION');
  const pending = (await transaction.client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM finance.posting_exception
     WHERE organization_id = $1 AND left(business_date::text, 7) = $2 AND status <> 'RESOLVED'`,
    [command.organizationId, period.code],
  )).rows[0]!.count;
  if (pending > 0 && !command.overrideExceptions) throw new DomainError('INVALID_STATE_TRANSITION');
  const closeRequestId = randomUUID();
  const approvalRequestId = randomUUID();
  const contextHash = createHash('sha256').update(JSON.stringify({
    periodId: period.id, periodCode: period.code, reason: command.reason,
    overrideExceptions: command.overrideExceptions, pendingExceptions: pending,
  })).digest('hex');
  await transaction.client.query(
    `INSERT INTO finance.period_close_request
       (id, organization_id, period_id, requested_by, reason, override_exceptions,
        status, approval_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING_APPROVAL',$7)`,
    [closeRequestId, command.organizationId, period.id, command.actorId,
      command.reason, command.overrideExceptions, approvalRequestId],
  );
  await transaction.client.query(
    `INSERT INTO finance.approval_effect
       (request_id, organization_id, approval_type, subject_type, subject_ref,
        subject_version, context_hash, status)
     VALUES ($1,$2,$3,'PeriodCloseRequest',$4,1,$5,'PENDING')`,
    [approvalRequestId, command.organizationId, ApprovalTypeCodeSchema.enum.period_close,
      closeRequestId, contextHash],
  );
  await transaction.appendAuditEntry({
    organizationId: command.organizationId, actor: { userId: command.actorId, roles: [] },
    action: 'ACCOUNTING_PERIOD_CLOSE_REQUESTED',
    entity: { domain: 'finance', type: 'PeriodCloseRequest', id: closeRequestId, version: 1 },
    changes: [{ path: 'status', classification: 'INTERNAL', after: 'PENDING_APPROVAL' },
      { path: 'pendingExceptions', classification: 'INTERNAL', after: pending }],
    reasonCode: command.reason, requestId: command.requestId, correlationId: command.requestId,
    source: 'API', retentionClass: 'FINANCIAL',
  });
  const businessDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  await appendOutboxEvent(transaction.client, {
    eventId: newEventId(), eventType: 'FINANCE_APPROVAL_SUBMITTED', eventVersion: 1,
    occurredAt: new Date().toISOString(), businessDate,
    organizationId: command.organizationId, aggregateType: 'FinanceApprovalEffect',
    aggregateId: approvalRequestId, aggregateVersion: 1, producer: 'finance',
    actor: { userId: command.actorId, roles: [] },
    correlationId: command.requestId, causationId: command.requestId,
    payload: { requestId: approvalRequestId, type: ApprovalTypeCodeSchema.enum.period_close,
      ownerDomain: 'finance', subjectType: 'PeriodCloseRequest', subjectRef: closeRequestId,
      subjectVersion: 1, requestedBy: command.actorId,
      summary: `Tutup periode ${period.code}`, scopeType: 'ORGANIZATION',
      scopeId: command.organizationId, contextHash },
  });
  return { periodId: period.id, closeRequestId, approvalRequestId, status: 'PENDING_APPROVAL' as const };
}
