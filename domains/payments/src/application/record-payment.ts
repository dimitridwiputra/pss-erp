import { randomUUID } from 'node:crypto';
import type { AuditedTransaction } from '@pss/audit';
import { BusinessDateSchema, DomainError, MoneyAmountSchema, newEventId } from '@pss/contracts';
import { appendOutboxEvent, withConnection } from '@pss/platform';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const RecordPaymentInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  channel: z.enum(['POS', 'CASHIER', 'BANK', 'FIELD']),
  method: z.enum(['TUNAI', 'QRIS', 'TRANSFER', 'GIRO', 'CEK']),
  // Matches payments.payment.amount: numeric(18,2), CHECK (amount > 0).
  amount: MoneyAmountSchema,
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  acceptedBy: z.uuid(),
  // Facts PAYMENT_RECEIVED v1 carries (MVP_PLAN §5). Stored with the payment, so the event is built
  // from the record rather than from the caller's input.
  customerId: z.uuid().optional(),
  invoiceId: z.uuid().nullable().optional(),
  cashLocation: z.strictObject({ type: z.literal('POS_SHIFT'), id: z.uuid() }).optional(),
  businessDate: BusinessDateSchema.optional(),
  requestId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
}).refine((input) => input.channel !== 'POS' || input.method !== 'TUNAI' || (
  input.referenceType === 'POS_SALE' && input.customerId !== undefined &&
  input.cashLocation !== undefined && input.businessDate !== undefined
), { path: ['channel'], message: 'A POS cash payment is against a POS sale, with its customer, cash location and business date.' });
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
  const requestId = input.requestId ?? randomUUID();
  const correlationId = input.correlationId ?? requestId;
  await transaction.client.query(
    `INSERT INTO payments.payment (
       id, organization_id, channel, method, amount, status, reference_type, reference_id, accepted_by,
       customer_id, invoice_id, cash_location_type, cash_location_id, business_date
     ) VALUES ($1, $2, $3, $4, $5, 'PENDING_VERIFICATION', $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      paymentId, input.organizationId, input.channel, input.method, input.amount, input.referenceType, input.referenceId,
      input.acceptedBy, input.customerId ?? null, input.invoiceId ?? null, input.cashLocation?.type ?? null,
      input.cashLocation?.id ?? null, input.businessDate ?? null,
    ],
  );
  await transaction.appendAuditEntry({
    organizationId: input.organizationId,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    actor: { userId: input.acceptedBy },
    action: 'PAYMENT_RECEIVED',
    entity: { domain: 'payments', type: 'Payment', id: paymentId, version: 1 },
    changes: [
      { path: 'status', classification: 'INTERNAL', after: 'PENDING_VERIFICATION' },
      { path: 'amount', classification: 'CONFIDENTIAL', after: input.amount },
    ],
    requestId,
    correlationId,
    source: 'API',
  });

  // Only the POS counter cash payment has a v1 payload (MVP_PLAN §5). The refine above guarantees
  // every field it needs; other channels and methods publish nothing until contracted (DOMAIN.md).
  if (input.channel === 'POS' && input.method === 'TUNAI' && input.customerId && input.cashLocation && input.businessDate) {
    await appendOutboxEvent(transaction.client, {
      eventId: newEventId(), eventType: 'PAYMENT_RECEIVED', eventVersion: 1,
      occurredAt: new Date().toISOString(), businessDate: input.businessDate,
      organizationId: input.organizationId, ...(input.branchId ? { branchId: input.branchId } : {}),
      aggregateType: 'Payment', aggregateId: paymentId, aggregateVersion: 1,
      producer: 'payments', actor: { userId: input.acceptedBy },
      correlationId, causationId: requestId,
      payload: {
        paymentId, method: 'TUNAI', amount: input.amount, currency: 'IDR', customerId: input.customerId,
        referenceType: 'POS_SALE', referenceId: input.referenceId, invoiceId: input.invoiceId ?? null,
        receivedBy: input.acceptedBy, cashLocationType: input.cashLocation.type, cashLocationId: input.cashLocation.id,
        businessDate: input.businessDate,
      },
    });
  }
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
 * transaction (e.g. a POS tender) folds the payment, its audit entry, and its
 * PAYMENT_RECEIVED event into the same commit; otherwise a dedicated
 * transaction is opened.
 */
export async function recordPayment(pool: Pool, client: PoolClient | undefined, rawInput: RecordPaymentInput): Promise<RecordedPayment> {
  const input = parseInput(rawInput);
  return withConnection(pool, client, (transaction) => insertPayment(transaction, input));
}
