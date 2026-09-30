import { randomUUID } from 'node:crypto';
import type { FinanceManualJournalInput } from '@pss/contracts';
import { DomainError } from '@pss/contracts';
import type { AuditedTransaction } from '@pss/platform';
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
