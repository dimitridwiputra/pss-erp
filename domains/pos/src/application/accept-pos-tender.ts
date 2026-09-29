import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withAuditedTransaction } from '@pss/audit';
import { recordPayment } from '@pss/payments';
import { DomainError } from '@pss/contracts';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const AcceptPosTenderSchema = z.strictObject({
  saleId: z.uuid(),
  method: z.literal('TUNAI'),
  cashReceived: z.string().regex(/^\d+(\.\d{1,2})?$/),
  acceptedBy: z.uuid(),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});
export type AcceptPosTenderInput = z.input<typeof AcceptPosTenderSchema>;

export interface AcceptedPosTender {
  tenderId: string; amount: string; changeAmount: string; saleStatus: 'PENDING_PAYMENT' | 'PAID';
}

/**
 * POS-006 (TUNAI only in this slice — QRIS/transfer are POS-007/008, deferred).
 * `amount` (allocated to the sale) is the Payment's nominal — never the raw cash
 * received (POS-006.BR01: change is never a Payment). P0 only supports single,
 * full-amount cash tenders (no split-tender across methods yet).
 */
export async function acceptPosTender(pool: Pool, raw: AcceptPosTenderInput): Promise<AcceptedPosTender> {
  const input = parseOrThrow(AcceptPosTenderSchema, raw);

  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const sale = await client.query<{ organization_id: string; total: string; status: string }>(
      'SELECT organization_id, total, status FROM pos.pos_sale WHERE id = $1 FOR UPDATE', [input.saleId],
    );
    const saleRow = sale.rows[0];
    if (!saleRow) throw new DomainError('NOT_FOUND');
    if (saleRow.status !== 'PENDING_PAYMENT') throw new DomainError('POS_SHIFT_NOT_OPEN');
    if (Number(input.cashReceived) < Number(saleRow.total)) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'cashReceived', code: 'insufficient', message: 'Periksa nilai ini.' }]);
    }

    const changeResult = await client.query<{ change: string }>(
      'SELECT ($1::numeric - $2::numeric)::text AS change', [input.cashReceived, saleRow.total],
    );
    const changeAmount = changeResult.rows[0]!.change;

    const payment = await recordPayment(pool, client, {
      organizationId: saleRow.organization_id, channel: 'POS', method: 'TUNAI', amount: saleRow.total,
      referenceType: 'POS_SALE', referenceId: input.saleId, acceptedBy: input.acceptedBy,
    });

    const tenderId = randomUUID();
    await client.query(
      `INSERT INTO pos.pos_tender (id, sale_id, method, status, amount, cash_received, change_amount, payment_id, accepted_by)
       VALUES ($1, $2, 'TUNAI', 'ACCEPTED', $3, $4, $5, $6, $7)`,
      [tenderId, input.saleId, saleRow.total, input.cashReceived, changeAmount, payment.paymentId, input.acceptedBy],
    );
    await client.query("UPDATE pos.pos_sale SET status = 'PAID', paid_at = now(), updated_at = now() WHERE id = $1", [input.saleId]);

    await appendAuditEntry({
      organizationId: saleRow.organization_id, actor: { userId: input.acceptedBy },
      action: 'POS_TENDER_ACCEPTED',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: 3 },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: 'PENDING_PAYMENT', after: 'PAID' },
        { path: 'tender.amount', classification: 'CONFIDENTIAL', after: saleRow.total },
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    return { tenderId, amount: saleRow.total, changeAmount, saleStatus: 'PAID' as const };
  });
}
