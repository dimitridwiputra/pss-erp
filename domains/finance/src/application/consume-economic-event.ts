import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Pool, PoolClient } from 'pg';
import { runAuditedWork } from '@pss/audit';
import { DomainError, newEventId, parseEventForPublication } from '@pss/contracts';
import { appendOutboxEvent, withInbox, type PublishableEvent } from '@pss/platform';
import { buildJournalFromEvent, PostingTemplateSchema, type JournalLine } from '../domain/posting-rule';

export const FINANCE_CONSUMER = 'finance.accounting.v1';
export const ECONOMIC_EVENT_TYPES = [
  'INVENTORY_RECEIVED', 'INVENTORY_ISSUED', 'INVENTORY_ADJUSTED',
  'INVOICE_ISSUED', 'PAYMENT_RECEIVED', 'CASH_CUSTODY_VERIFIED',
] as const;

const inbox = {
  reserve: async (client: PoolClient, eventId: string) => {
    const receipt = await client.query(
      'INSERT INTO finance.event_inbox (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId],
    );
    return receipt.rowCount === 1;
  },
};

function businessDate(event: PublishableEvent): string { return event.businessDate; }

function sourceNumber(event: PublishableEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['invoiceNumber', 'sourceId', 'referenceId']) {
    if (typeof payload[key] === 'string') return payload[key];
  }
  return null;
}

function sourceId(event: PublishableEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['invoiceId', 'paymentId', 'cashCustodyRecordId', 'adjustmentId', 'sourceId', 'movementId']) {
    if (typeof payload[key] === 'string') return payload[key];
  }
  return null;
}

async function writeException(client: PoolClient, event: PublishableEvent, reasonCode: string) {
  await client.query(
    `INSERT INTO finance.posting_exception
       (organization_id, event_id, event_type, business_date, reason_code, payload_reference)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (event_id) DO UPDATE SET reason_code = EXCLUDED.reason_code,
       payload_reference = EXCLUDED.payload_reference, status = 'OPEN', updated_at = now()`,
    [event.organizationId, event.eventId, event.eventType, businessDate(event), reasonCode, JSON.stringify(event)],
  );
}

async function recordSubledger(client: PoolClient, event: PublishableEvent) {
  const payload = event.payload as Record<string, unknown>;
  let inventory = '0.00', receivable = '0.00';
  if (event.eventType === 'INVENTORY_RECEIVED' && typeof payload.totalCost === 'string') inventory = payload.totalCost;
  if (event.eventType === 'INVENTORY_ISSUED' && typeof payload.totalCost === 'string') inventory = new Decimal(payload.totalCost).negated().toFixed(2);
  if (event.eventType === 'INVENTORY_ADJUSTED' && typeof payload.totalCostDelta === 'string') inventory = payload.totalCostDelta;
  if (event.eventType === 'INVOICE_ISSUED' && typeof payload.total === 'string') receivable = payload.total;
  if (event.eventType === 'PAYMENT_RECEIVED' && typeof payload.amount === 'string') receivable = new Decimal(payload.amount).negated().toFixed(2);
  await client.query(
    `INSERT INTO finance.subledger_event
       (event_id, organization_id, event_type, business_date, inventory_delta, receivable_delta)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO NOTHING`,
    [event.eventId, event.organizationId, event.eventType, businessDate(event), inventory, receivable],
  );
}

async function activeAccounts(client: PoolClient, lines: readonly JournalLine[]) {
  const codes = [...new Set(lines.map((line) => line.accountCode))];
  const result = await client.query<{ code: string }>(
    'SELECT code FROM finance.account WHERE code = ANY($1::text[]) AND active', [codes],
  );
  return result.rows.length === codes.length;
}

/** One inbox transaction contains the receipt, finance ledger effect, audit and outbox row. */
export async function consumeEconomicEvent(pool: Pool, rawEvent: unknown) {
  return withInbox(pool, inbox, rawEvent, processEconomicEvent);
}

async function processEconomicEvent(client: PoolClient, event: PublishableEvent) {
    if (!ECONOMIC_EVENT_TYPES.some((name) => name === event.eventType)) throw new Error(`Not an economic finance event: ${event.eventType}`);
    return runAuditedWork(client, async ({ appendAuditEntry }) => {
      const existing = await client.query('SELECT id FROM finance.journal WHERE source_event_id = $1', [event.eventId]);
      if (existing.rowCount) return { status: 'DUPLICATE_JOURNAL' as const };

      await recordSubledger(client, event);
      const periodCode = businessDate(event).slice(0, 7);
      const period = (await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM finance.accounting_period
         WHERE organization_id = $1 AND code = $2 FOR UPDATE`, [event.organizationId, periodCode],
      )).rows[0];

      let reason: string | null = null;
      let lines: JournalLine[] = [];
      let ruleId: string | null = null;
      if (!period) reason = 'PERIOD_NOT_FOUND';
      else if (period.status === 'CLOSED') reason = 'PERIOD_CLOSED';
      else {
        const rule = (await client.query<{ id: string; line_template: unknown }>(
          `SELECT id, line_template FROM finance.posting_rule
           WHERE event_type = $1 AND active AND effective_from <= $2::date
             AND (effective_to IS NULL OR effective_to > $2::date)
           ORDER BY version DESC LIMIT 1`, [event.eventType, businessDate(event)],
        )).rows[0];
        if (!rule) reason = 'POSTING_RULE_NOT_FOUND';
        else {
          const template = PostingTemplateSchema.safeParse(rule.line_template);
          const result = template.success
            ? buildJournalFromEvent(template.data, event)
            : { ok: false as const, code: 'INVALID_PAYLOAD' as const };
          if (!result.ok) reason = result.code;
          else if (!await activeAccounts(client, result.lines)) reason = 'ACCOUNT_INACTIVE_OR_MISSING';
          else { lines = result.lines; ruleId = rule.id; }
        }
      }
      if (reason) {
        await writeException(client, event, reason);
        await appendAuditEntry({
          organizationId: event.organizationId, actor: { serviceIdentity: FINANCE_CONSUMER, roles: [] },
          action: 'FINANCE_POSTING_EXCEPTION_OPENED',
          entity: { domain: 'finance', type: 'PostingException', id: event.eventId, version: 1 },
          changes: [{ path: 'reasonCode', classification: 'INTERNAL', after: reason }],
          requestId: event.correlationId, correlationId: event.correlationId,
          causationId: event.eventId, source: 'SYSTEM', retentionClass: 'FINANCIAL',
        });
        return { status: 'EXCEPTION' as const, reason };
      }

      const journalId = randomUUID();
      const number = `JV-${periodCode.replace('-', '')}-${event.eventId}`;
      await client.query(
        `INSERT INTO finance.journal
           (id, organization_id, number, period_id, business_date, source_type, source_event_id,
            source_document_id, source_document_number, posting_rule_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT')`,
        [journalId, event.organizationId, number, period!.id, businessDate(event), event.eventType,
          event.eventId, sourceId(event), sourceNumber(event), ruleId],
      );
      for (const [index, entry] of lines.entries()) {
        await client.query(
          `INSERT INTO finance.journal_line (journal_id, line_number, account_code, debit, credit, memo)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [journalId, index + 1, entry.accountCode, entry.debit, entry.credit, entry.memo],
        );
      }
      // The DB trigger independently checks the sum at the DRAFT → POSTED transition.
      await client.query(
        `UPDATE finance.journal SET status = 'POSTED', posted_at = now(), updated_at = now()
         WHERE id = $1`, [journalId],
      );
      await client.query(
        `UPDATE finance.posting_exception SET status = 'RESOLVED', journal_id = $2, updated_at = now()
         WHERE event_id = $1 AND status <> 'RESOLVED'`, [event.eventId, journalId],
      );
      await appendAuditEntry({
        organizationId: event.organizationId, actor: { serviceIdentity: FINANCE_CONSUMER, roles: [] },
        action: 'JOURNAL_POSTED', entity: { domain: 'finance', type: 'Journal', id: journalId, version: 1 },
        changes: [{ path: 'status', classification: 'INTERNAL', after: 'POSTED' }],
        requestId: event.correlationId, correlationId: event.correlationId,
        causationId: event.eventId, source: 'SYSTEM', retentionClass: 'FINANCIAL',
      });
      const total = lines.reduce((sum, entry) => sum.plus(entry.debit), new Decimal(0)).toFixed(2);
      await appendOutboxEvent(client, {
        eventId: newEventId(), eventType: 'JOURNAL_POSTED', eventVersion: 1,
        occurredAt: new Date().toISOString(), businessDate: businessDate(event),
        organizationId: event.organizationId, aggregateType: 'Journal', aggregateId: journalId,
        aggregateVersion: 1, producer: 'finance', actor: { serviceIdentity: FINANCE_CONSUMER },
        correlationId: event.correlationId, causationId: event.eventId,
        payload: { journalId, journalNumber: number, periodCode, businessDate: businessDate(event),
          sourceType: event.eventType, sourceEventId: event.eventId, totalDebit: total, totalCredit: total },
      });
      return { status: 'POSTED' as const, journalId };
    });
}

/** A controlled retry uses the persisted original envelope; journal.source_event_id remains unique. */
export async function retryPostingException(client: PoolClient, organizationId: string, exceptionId: string) {
  const row = (await client.query<{ payload_reference: unknown; status: string }>(
    `SELECT payload_reference, status FROM finance.posting_exception
     WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [exceptionId, organizationId],
  )).rows[0];
  if (!row) throw new DomainError('NOT_FOUND');
  if (row.status === 'RESOLVED') throw new DomainError('INVALID_STATE_TRANSITION');
  const event = parseEventForPublication(row.payload_reference);
  const result = await processEconomicEvent(client, event);
  if (result.status !== 'POSTED') throw new DomainError('INVALID_STATE_TRANSITION');
  return result;
}
