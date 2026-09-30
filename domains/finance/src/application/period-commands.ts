import type { AuditedTransaction } from '@pss/platform';
import { appendOutboxEvent } from '@pss/platform';
import { DomainError, newEventId } from '@pss/contracts';

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
