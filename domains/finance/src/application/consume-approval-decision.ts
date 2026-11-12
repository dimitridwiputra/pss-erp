import Decimal from 'decimal.js';
import type { Pool, PoolClient } from 'pg';
import { runAuditedWork, type AuditedTransaction } from '@pss/audit';
import { ApprovalDecidedV2Schema, ApprovalTypeCodeSchema, DomainError, newEventId } from '@pss/contracts';
import { appendOutboxEvent, withInbox } from '@pss/platform';
import { validateBalancedLines, type JournalLine } from '../domain/posting-rule';
import { closePeriod } from './period-commands';

const inbox = {
  reserve: async (client: PoolClient, eventId: string) => (await client.query(
    'INSERT INTO finance.event_inbox (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId],
  )).rowCount === 1,
};

/** Finance alone applies the business effect of a Platform decision. */
export async function consumeFinanceApprovalDecision(pool: Pool, rawEvent: unknown) {
  const event = ApprovalDecidedV2Schema.parse(rawEvent);
  if (event.payload.ownerDomain !== 'finance') return { status: 'OTHER_DOMAIN' as const };
  return withInbox(pool, inbox, event, async (client, received) => {
    const decision = ApprovalDecidedV2Schema.parse(received);
    return runAuditedWork(client, async ({ appendAuditEntry }) => {
      const payload = decision.payload;
      const auditOutcome = async (action: string, outcome: string) => appendAuditEntry({
        organizationId: decision.organizationId,
        actor: { serviceIdentity: 'finance.approval-effect', roles: [] }, action,
        entity: { domain: 'finance', type: payload.subjectType, id: payload.subjectRef,
          version: payload.subjectVersion },
        changes: [{ path: 'approvalEffect', classification: 'INTERNAL', after: outcome }],
        requestId: payload.requestId, correlationId: decision.correlationId,
        causationId: decision.eventId, source: 'SYSTEM', retentionClass: 'FINANCIAL',
      });
      const effect = (await client.query<{
        request_id: string; approval_type: string; subject_type: string;
        subject_ref: string; subject_version: number; status: string;
      }>(
        `SELECT request_id, approval_type, subject_type, subject_ref, subject_version, status
         FROM finance.approval_effect WHERE request_id = $1 AND organization_id = $2 FOR UPDATE`,
        [payload.requestId, decision.organizationId],
      )).rows[0];
      if (!effect) throw new Error('Approval decision has no Finance subject correlation.');
      if (effect.status !== 'PENDING') {
        await auditOutcome('FINANCE_DUPLICATE_APPROVAL_IGNORED', effect.status);
        return { status: 'DUPLICATE_REQUEST' as const };
      }
      const matches = effect.approval_type === payload.type && effect.subject_type === payload.subjectType
        && effect.subject_ref === payload.subjectRef && effect.subject_version === payload.subjectVersion;
      if (!matches) {
        await client.query(
          `UPDATE finance.approval_effect SET status = 'STALE', reason = 'SUBJECT_MISMATCH',
           decision_event_id = $2, updated_at = now() WHERE request_id = $1`,
          [payload.requestId, decision.eventId],
        );
        await auditOutcome('FINANCE_APPROVAL_STALE', 'SUBJECT_MISMATCH');
        return { status: 'STALE' as const };
      }
      if (payload.type === ApprovalTypeCodeSchema.enum.period_reopen) {
        return applyPeriodReopenDecision(client, decision, appendAuditEntry);
      }
      if (payload.type === ApprovalTypeCodeSchema.enum.period_close) {
        return applyPeriodCloseDecision(client, decision, appendAuditEntry);
      }
      if (payload.type !== ApprovalTypeCodeSchema.enum.journal
        && payload.type !== ApprovalTypeCodeSchema.enum.journal_reversal) {
        throw new Error(`Finance approval type ${payload.type} has no effect handler.`);
      }
      const journal = (await client.query<{
        id: string; number: string; status: string; version: number; maker_id: string;
        source_type: string; business_date: string; period_id: string; reverses_journal_id: string | null;
        approval_request_id: string | null;
      }>(
        `SELECT id, number, status, version, maker_id, source_type, business_date::text,
                period_id, reverses_journal_id, approval_request_id
         FROM finance.journal WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [payload.subjectRef, decision.organizationId],
      )).rows[0];
      if (!journal || journal.version !== payload.subjectVersion || journal.status !== 'PENDING_APPROVAL'
        || journal.approval_request_id !== payload.requestId) {
        await client.query(
          `UPDATE finance.approval_effect SET status = 'STALE', reason = 'SUBJECT_VERSION_CHANGED',
           decision_event_id = $2, updated_at = now() WHERE request_id = $1`,
          [payload.requestId, decision.eventId],
        );
        await auditOutcome('FINANCE_APPROVAL_STALE', 'SUBJECT_VERSION_CHANGED');
        return { status: 'STALE' as const };
      }
      if (payload.decision !== 'APPROVED') {
        await client.query(
          `UPDATE finance.journal SET status = $2, version = version + 1,
           approval_request_id = NULL, updated_at = now() WHERE id = $1`,
          [journal.id, journal.reverses_journal_id ? 'REJECTED' : 'DRAFT'],
        );
        await client.query(
          `UPDATE finance.approval_effect SET status = 'APPLIED', decision_event_id = $2,
           updated_at = now() WHERE request_id = $1`, [payload.requestId, decision.eventId],
        );
        await appendAuditEntry({
          organizationId: decision.organizationId, actor: { userId: payload.decidedBy, roles: [] },
          action: 'MANUAL_JOURNAL_APPROVAL_REJECTED',
          entity: { domain: 'finance', type: 'Journal', id: journal.id, version: journal.version + 1 },
          changes: [{ path: 'status', classification: 'INTERNAL', before: 'PENDING_APPROVAL',
            after: journal.reverses_journal_id ? 'REJECTED' : 'DRAFT' }],
          reasonCode: payload.reason, requestId: payload.requestId,
          correlationId: decision.correlationId, causationId: decision.eventId,
          source: 'SYSTEM', retentionClass: 'FINANCIAL',
        });
        return { status: 'REJECTED' as const };
      }
      if (payload.decidedBy === journal.maker_id) {
        await client.query(
          `UPDATE finance.approval_effect SET status = 'FAILED', reason = 'SEGREGATION_OF_DUTIES',
           decision_event_id = $2, updated_at = now() WHERE request_id = $1`,
          [payload.requestId, decision.eventId],
        );
        await auditOutcome('FINANCE_APPROVAL_FAILED', 'SEGREGATION_OF_DUTIES');
        return { status: 'FAILED' as const, reason: 'SEGREGATION_OF_DUTIES' };
      }
      const period = (await client.query<{ status: string; code: string }>(
        `SELECT code, status FROM finance.accounting_period WHERE id = $1 FOR UPDATE`, [journal.period_id],
      )).rows[0];
      if (!period || period.status === 'CLOSED'
        || (period.status === 'SOFT_CLOSED' && journal.source_type !== 'ADJUSTMENT' && journal.source_type !== 'REVERSAL')) {
        await client.query(
          `UPDATE finance.approval_effect SET status = 'FAILED', reason = 'PERIOD_CLOSED',
           decision_event_id = $2, updated_at = now() WHERE request_id = $1`,
          [payload.requestId, decision.eventId],
        );
        await auditOutcome('FINANCE_APPROVAL_FAILED', 'PERIOD_CLOSED');
        return { status: 'FAILED' as const, reason: 'PERIOD_CLOSED' };
      }
      const lines = (await client.query<JournalLine>(
        `SELECT account_code AS "accountCode", debit::text, credit::text, COALESCE(memo,'') AS memo
         FROM finance.journal_line WHERE journal_id = $1 ORDER BY line_number`, [journal.id],
      )).rows;
      const failEffect = async (reason: string) => {
        await client.query(
          `UPDATE finance.approval_effect SET status = 'FAILED', reason = $2,
           decision_event_id = $3, updated_at = now() WHERE request_id = $1`,
          [payload.requestId, reason, decision.eventId],
        );
        await auditOutcome('FINANCE_APPROVAL_FAILED', reason);
        return { status: 'FAILED' as const, reason };
      };
      if (!validateBalancedLines(lines)) return failEffect('JOURNAL_NOT_BALANCED');
      const invalidAccounts = (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM finance.journal_line line
         JOIN finance.account account ON account.code = line.account_code
         WHERE line.journal_id = $1 AND NOT account.active`, [journal.id],
      )).rows[0]!.count;
      if (invalidAccounts > 0) return failEffect('ACCOUNT_INACTIVE');
      if (journal.source_type === 'MANUAL' || journal.source_type === 'ADJUSTMENT') {
        const restricted = (await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM finance.journal_line line
           JOIN finance.account_role_mapping mapping ON mapping.account_code = line.account_code
           JOIN finance.account_role role ON role.code = mapping.role_code
           WHERE line.journal_id = $1 AND role.manual_posting_policy = 'DENY'
             AND mapping.effective_from <= $2::date
             AND (mapping.effective_to IS NULL OR mapping.effective_to > $2::date)`,
          [journal.id, journal.business_date],
        )).rows[0]!.count;
        if (restricted > 0) return failEffect('CONTROL_ACCOUNT_MANUAL_POSTING');
      }
      await client.query(
        `UPDATE finance.journal SET status = 'POSTED', approver_id = $2, posted_at = now(),
         version = version + 1, updated_at = now() WHERE id = $1`, [journal.id, payload.decidedBy],
      );
      if (journal.reverses_journal_id) {
        await client.query(
          `UPDATE finance.journal SET status = 'REVERSED', reversed_by_journal_id = $2,
           updated_at = now() WHERE id = $1`, [journal.reverses_journal_id, journal.id],
        );
      }
      await client.query(
        `UPDATE finance.approval_effect SET status = 'APPLIED', decision_event_id = $2,
         updated_at = now() WHERE request_id = $1`, [payload.requestId, decision.eventId],
      );
      await appendAuditEntry({
        organizationId: decision.organizationId, actor: { userId: payload.decidedBy, roles: [] },
        action: journal.reverses_journal_id ? 'JOURNAL_REVERSED' : 'JOURNAL_POSTED',
        entity: { domain: 'finance', type: 'Journal', id: journal.id, version: journal.version + 1 },
        changes: [{ path: 'status', classification: 'INTERNAL', before: 'PENDING_APPROVAL', after: 'POSTED' }],
        requestId: payload.requestId, correlationId: decision.correlationId,
        causationId: decision.eventId, source: 'SYSTEM', retentionClass: 'FINANCIAL',
      });
      const total = lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0)).toFixed(2);
      await appendOutboxEvent(client, {
        eventId: newEventId(), eventType: 'JOURNAL_POSTED', eventVersion: 1,
        occurredAt: new Date().toISOString(), businessDate: journal.business_date,
        organizationId: decision.organizationId, aggregateType: 'Journal', aggregateId: journal.id,
        aggregateVersion: journal.version + 1, producer: 'finance',
        actor: { userId: payload.decidedBy, roles: [] }, correlationId: decision.correlationId,
        causationId: decision.eventId,
        payload: { journalId: journal.id, journalNumber: journal.number, periodCode: period.code,
          businessDate: journal.business_date, sourceType: journal.source_type,
          sourceEventId: null, totalDebit: total, totalCredit: total },
      });
      if (journal.reverses_journal_id) {
        await appendOutboxEvent(client, {
          eventId: newEventId(), eventType: 'JOURNAL_REVERSED', eventVersion: 1,
          occurredAt: new Date().toISOString(), businessDate: journal.business_date,
          organizationId: decision.organizationId, aggregateType: 'Journal', aggregateId: journal.id,
          aggregateVersion: journal.version + 2, producer: 'finance',
          actor: { userId: payload.decidedBy, roles: [] }, correlationId: decision.correlationId,
          causationId: decision.eventId,
          payload: { journalId: journal.reverses_journal_id, reversalJournalId: journal.id,
            reasonCode: payload.reason ?? 'JOURNAL_REVERSAL' },
        });
      }
      return { status: 'POSTED' as const, journalId: journal.id };
    });
  });
}

async function applyPeriodCloseDecision(client: PoolClient,
  decision: ReturnType<typeof ApprovalDecidedV2Schema.parse>,
  appendAuditEntry: AuditedTransaction['appendAuditEntry']) {
  const payload = decision.payload;
  const request = (await client.query<{
    id: string; period_id: string; requested_by: string; reason: string;
    override_exceptions: boolean; status: string; version: number; approval_request_id: string;
  }>(
    `SELECT id, period_id, requested_by, reason, override_exceptions,
            status, version, approval_request_id
     FROM finance.period_close_request WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [payload.subjectRef, decision.organizationId],
  )).rows[0];
  if (!request || request.approval_request_id !== payload.requestId
    || request.version !== payload.subjectVersion || request.status !== 'PENDING_APPROVAL') {
    await client.query(
      `UPDATE finance.approval_effect SET status = 'STALE', reason = 'SUBJECT_VERSION_CHANGED',
       decision_event_id = $2, updated_at = now() WHERE request_id = $1`,
      [payload.requestId, decision.eventId],
    );
    await appendPeriodCloseOutcome(appendAuditEntry, decision, 'FINANCE_APPROVAL_STALE', 'STALE');
    return { status: 'STALE' as const };
  }
  if (payload.decision === 'APPROVED' && payload.decidedBy === request.requested_by) {
    throw new Error('SEGREGATION_OF_DUTIES');
  }
  let status: 'APPLIED' | 'REJECTED' | 'FAILED' = 'REJECTED';
  if (payload.decision === 'APPROVED') {
    try {
      await closePeriod({ client, appendAuditEntry }, {
        organizationId: decision.organizationId, actorId: payload.decidedBy,
        periodId: request.period_id, requestId: payload.requestId,
        reason: request.reason, overrideExceptions: request.override_exceptions,
      });
      status = 'APPLIED';
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'INVALID_STATE_TRANSITION')) throw error;
      // The decision remains final, while the owner's effect is visible for repair.
      status = 'FAILED';
    }
  }
  await client.query(
    `UPDATE finance.period_close_request SET status = $2, updated_at = now() WHERE id = $1`,
    [request.id, status],
  );
  await client.query(
    `UPDATE finance.approval_effect SET status = $2, decision_event_id = $3,
     reason = $4, updated_at = now() WHERE request_id = $1`,
    [payload.requestId, status === 'REJECTED' ? 'APPLIED' : status, decision.eventId,
      status === 'FAILED' ? 'CLOSE_GUARD_FAILED' : null],
  );
  if (status !== 'APPLIED') {
    await appendPeriodCloseOutcome(appendAuditEntry, decision,
      status === 'FAILED' ? 'FINANCE_APPROVAL_FAILED' : 'ACCOUNTING_PERIOD_CLOSE_REJECTED', status);
  }
  return { status };
}

function appendPeriodCloseOutcome(appendAuditEntry: AuditedTransaction['appendAuditEntry'],
  decision: ReturnType<typeof ApprovalDecidedV2Schema.parse>, action: string, outcome: string) {
  return appendAuditEntry({
    organizationId: decision.organizationId,
    actor: { serviceIdentity: 'finance.approval-effect', roles: [] }, action,
    entity: { domain: 'finance', type: 'PeriodCloseRequest', id: decision.payload.subjectRef,
      version: decision.payload.subjectVersion },
    changes: [{ path: 'approvalEffect', classification: 'INTERNAL', after: outcome }],
    requestId: decision.payload.requestId, correlationId: decision.correlationId,
    causationId: decision.eventId, source: 'SYSTEM', retentionClass: 'FINANCIAL',
  });
}

async function applyPeriodReopenDecision(client: PoolClient,
  decision: ReturnType<typeof ApprovalDecidedV2Schema.parse>,
  appendAuditEntry: AuditedTransaction['appendAuditEntry']) {
  const payload = decision.payload;
  const request = (await client.query<{
    id: string; period_id: string; requested_by: string; reason: string;
    status: string; version: number; approval_request_id: string;
  }>(
    `SELECT id, period_id, requested_by, reason, status, version, approval_request_id
     FROM finance.period_reopen_request WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [payload.subjectRef, decision.organizationId],
  )).rows[0];
  if (!request || request.approval_request_id !== payload.requestId
    || request.version !== payload.subjectVersion || request.status !== 'PENDING_APPROVAL') {
    await client.query(
      `UPDATE finance.approval_effect SET status = 'STALE', reason = 'SUBJECT_VERSION_CHANGED',
       decision_event_id = $2, updated_at = now() WHERE request_id = $1`,
      [payload.requestId, decision.eventId],
    );
    await appendAuditEntry({
      organizationId: decision.organizationId,
      actor: { serviceIdentity: 'finance.approval-effect', roles: [] },
      action: 'FINANCE_APPROVAL_STALE',
      entity: { domain: 'finance', type: 'PeriodReopenRequest', id: payload.subjectRef,
        version: payload.subjectVersion },
      changes: [{ path: 'approvalEffect', classification: 'INTERNAL', after: 'SUBJECT_VERSION_CHANGED' }],
      requestId: payload.requestId, correlationId: decision.correlationId,
      causationId: decision.eventId, source: 'SYSTEM', retentionClass: 'FINANCIAL',
    });
    return { status: 'STALE' as const };
  }
  const period = (await client.query<{ id: string; code: string; status: string }>(
    `SELECT id, code, status FROM finance.accounting_period WHERE id = $1 FOR UPDATE`,
    [request.period_id],
  )).rows[0];
  if (!period || period.status !== 'CLOSED') {
    await client.query(
      `UPDATE finance.period_reopen_request SET status = 'STALE', updated_at = now() WHERE id = $1`,
      [request.id],
    );
    await client.query(
      `UPDATE finance.approval_effect SET status = 'STALE', reason = 'PERIOD_STATE_CHANGED',
       decision_event_id = $2, updated_at = now() WHERE request_id = $1`,
      [payload.requestId, decision.eventId],
    );
    await appendAuditEntry({
      organizationId: decision.organizationId,
      actor: { serviceIdentity: 'finance.approval-effect', roles: [] },
      action: 'FINANCE_APPROVAL_STALE',
      entity: { domain: 'finance', type: 'PeriodReopenRequest', id: payload.subjectRef,
        version: payload.subjectVersion },
      changes: [{ path: 'approvalEffect', classification: 'INTERNAL', after: 'PERIOD_STATE_CHANGED' }],
      requestId: payload.requestId, correlationId: decision.correlationId,
      causationId: decision.eventId, source: 'SYSTEM', retentionClass: 'FINANCIAL',
    });
    return { status: 'STALE' as const };
  }
  if (payload.decision !== 'APPROVED') {
    await client.query(
      `UPDATE finance.period_reopen_request SET status = 'REJECTED', updated_at = now() WHERE id = $1`,
      [request.id],
    );
  } else {
    if (payload.decidedBy === request.requested_by) throw new Error('SEGREGATION_OF_DUTIES');
    await client.query(
      `UPDATE finance.accounting_period SET status = 'SOFT_CLOSED', reopened_at = now(),
       reopened_by = $2, reopen_reason = $3, reopen_approval_id = $4,
       updated_at = now() WHERE id = $1`,
      [period.id, payload.decidedBy, request.reason, payload.requestId],
    );
    await client.query(
      `UPDATE finance.period_reopen_request SET status = 'APPLIED', updated_at = now() WHERE id = $1`,
      [request.id],
    );
  }
  await client.query(
    `UPDATE finance.approval_effect SET status = 'APPLIED', decision_event_id = $2,
     updated_at = now() WHERE request_id = $1`, [payload.requestId, decision.eventId],
  );
  await appendAuditEntry({
    organizationId: decision.organizationId, actor: { userId: payload.decidedBy, roles: [] },
    action: payload.decision === 'APPROVED' ? 'ACCOUNTING_PERIOD_REOPENED' : 'ACCOUNTING_PERIOD_REOPEN_REJECTED',
    entity: { domain: 'finance', type: 'AccountingPeriod', id: period.id, version: request.version + 1 },
    changes: [{ path: 'status', classification: 'INTERNAL', before: 'CLOSED',
      after: payload.decision === 'APPROVED' ? 'SOFT_CLOSED' : 'CLOSED' }],
    reasonCode: request.reason, requestId: payload.requestId,
    correlationId: decision.correlationId, causationId: decision.eventId,
    source: 'SYSTEM', retentionClass: 'FINANCIAL',
  });
  if (payload.decision === 'APPROVED') {
    await appendOutboxEvent(client, {
      eventId: newEventId(), eventType: 'ACCOUNTING_PERIOD_REOPENED', eventVersion: 1,
      occurredAt: new Date().toISOString(), businessDate: decision.businessDate,
      organizationId: decision.organizationId, aggregateType: 'AccountingPeriod',
      aggregateId: period.id, aggregateVersion: request.version + 1, producer: 'finance',
      actor: { userId: payload.decidedBy, roles: [] }, correlationId: decision.correlationId,
      causationId: decision.eventId,
      payload: { periodId: period.id, periodCode: period.code, reopenedBy: payload.decidedBy,
        approvalRequestId: payload.requestId, reason: request.reason },
    });
  }
  return { status: payload.decision === 'APPROVED' ? 'APPLIED' as const : 'REJECTED' as const };
}
