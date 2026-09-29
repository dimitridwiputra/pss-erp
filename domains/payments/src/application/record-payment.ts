import { randomUUID } from 'node:crypto';
import { runAuditedWork, withAuditedTransaction, type AuditedTransaction } from '@pss/audit';
import { DomainError, MoneyAmountSchema } from '@pss/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const RecordPaymentInputSchema = z.strictObject({
  organizationId: z.uuid(),
  channel: z.enum(['POS', 'CASHIER', 'BANK', 'FIELD']),
  method: z.enum(['TUNAI', 'QRIS', 'TRANSFER', 'GIRO', 'CEK']),
  // Matches payments.payment.amount: numeric(18,2), CHECK (amount > 0).
  amount: MoneyAmountSchema,
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  acceptedBy: z.uuid(),
});

export type RecordPaymentInput = z.input<typeof RecordPaymentInputSchema>;
type ParsedRecordPaymentInput = z.output<typeof RecordPaymentInputSchema>;

export interface RecordedPayment {
  paymentId: string;
  status: 'PENDING_VERIFICATION';
}

function parseInput(rawInput: RecordPaymentInput): ParsedRecordPaymentInput {
  const parsed = RecordPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  return parsed.data;
}

async function insertPayment(transaction: AuditedTransaction, input: ParsedRecordPaymentInput): Promise<RecordedPayment> {
  const paymentId = randomUUID();
  await transaction.client.query(
    `INSERT INTO payments.payment (
       id, organization_id, channel, method, amount, status, reference_type, reference_id, accepted_by
     ) VALUES ($1, $2, $3, $4, $5, 'PENDING_VERIFICATION', $6, $7, $8)`,
    [paymentId, input.organizationId, input.channel, input.method, input.amount, input.referenceType, input.referenceId, input.acceptedBy],
  );
  await transaction.appendAuditEntry({
    organizationId: input.organizationId,
    actor: { userId: input.acceptedBy },
    action: 'PAYMENT_RECEIVED',
    entity: { domain: 'payments', type: 'Payment', id: paymentId, version: 1 },
    changes: [
      { path: 'status', classification: 'INTERNAL', after: 'PENDING_VERIFICATION' },
      { path: 'amount', classification: 'CONFIDENTIAL', after: input.amount },
    ],
    requestId: randomUUID(),
    correlationId: randomUUID(),
    source: 'API',
  });
  return { paymentId, status: 'PENDING_VERIFICATION' };
}

/**
 * Records a tendered payment as PENDING_VERIFICATION. This is bookkeeping of the
 * accepted amount only — verification is a separate, method-specific command.
 * TUNAI is the only method with an implemented verification path in this slice
 * (declareCashHandover / verifyCashCustody); QRIS/TRANSFER/GIRO/CEK are valid
 * schema values here but have no verification command yet (see DOMAIN.md).
 *
 * Accepts an optional shared `client` so a caller already inside a write
 * transaction (e.g. a POS shift command) can fold this into the same commit;
 * otherwise a dedicated transaction is opened.
 */
export async function recordPayment(pool: Pool, client: PoolClient | undefined, rawInput: RecordPaymentInput): Promise<RecordedPayment> {
  const input = parseInput(rawInput);
  if (client) return runAuditedWork(client, (transaction) => insertPayment(transaction, input));
  return withAuditedTransaction(pool, (transaction) => insertPayment(transaction, input));
}
