import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { recordPayment } from '@pss/payments';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { jakartaBusinessDate, MoneyInputSchema, parseOrThrow, RequestMetaShape } from './support/command-input';

const AcceptPosTenderSchema = z.strictObject({
  saleId: z.uuid(),
  method: z.literal('TUNAI'),
  cashReceived: MoneyInputSchema,
  acceptedBy: z.uuid(),
  ...RequestMetaShape,
});
export type AcceptPosTenderInput = z.input<typeof AcceptPosTenderSchema>;

export interface AcceptedPosTender {
  tenderId: string; paymentId: string; amount: string; cashReceived: string; changeAmount: string; saleStatus: 'PAID';
}

/**
 * POS-006 (TUNAI only in this slice — QRIS/transfer are POS-007/008, deferred).
 * `amount` (allocated to the sale) is the Payment's nominal — never the raw cash
 * received (POS-006.BR01: change is never a Payment). P0 only supports single,
 * full-amount cash tenders (no split-tender across methods yet).
 *
 * The payment, its PAYMENT_RECEIVED event, the tender and the sale's PAID state commit together.
 */
export async function acceptPosTender(pool: Pool, client: PoolClient | undefined, raw: AcceptPosTenderInput): Promise<AcceptedPosTender> {
  const input = parseOrThrow(AcceptPosTenderSchema, raw);

  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const sale = await client.query<{
      organization_id: string; total: string; status: string; version: number; shift_id: string; shift_status: string;
      branch_id: string; customer_id: string | null; invoice_id: string | null; enough: boolean; change: string;
    }>(
      `SELECT sale.organization_id, sale.total::text, sale.status, sale.version, sale.shift_id, s.status AS shift_status,
              t.branch_id, sale.customer_id, sale.invoice_id,
              $2::numeric >= sale.total AS enough, ($2::numeric - sale.total)::numeric(18,2)::text AS change
       FROM pos.pos_sale sale JOIN pos.pos_shift s ON s.id = sale.shift_id JOIN pos.pos_terminal t ON t.id = sale.terminal_id
       WHERE sale.id = $1 FOR UPDATE OF sale`,
      [input.saleId, input.cashReceived],
    );
    const saleRow = sale.rows[0];
    if (!saleRow) throw new DomainError('NOT_FOUND');
    if (saleRow.status !== 'PENDING_PAYMENT') throw new DomainError('INVALID_STATE_TRANSITION');
    if (saleRow.shift_status !== 'OPEN') throw new DomainError('POS_SHIFT_NOT_OPEN');
    if (!saleRow.customer_id) throw new Error('A checked-out POS sale has no customer.');
    // Compared in Postgres: a JS Number comparison of money strings was a float comparison.
    if (!saleRow.enough) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'cashReceived', code: 'too_small', message: 'Uang yang diterima kurang dari total belanja.' }]);
    }

    const payment = await recordPayment(pool, client, {
      organizationId: saleRow.organization_id, branchId: saleRow.branch_id, channel: 'POS', method: 'TUNAI', amount: saleRow.total,
      referenceType: 'POS_SALE', referenceId: input.saleId, acceptedBy: input.acceptedBy,
      customerId: saleRow.customer_id, invoiceId: saleRow.invoice_id,
      cashLocation: { type: 'POS_SHIFT', id: saleRow.shift_id }, businessDate: jakartaBusinessDate(),
      requestId: input.requestId, correlationId: input.correlationId,
    });

    const tenderId = randomUUID();
    await client.query(
      `INSERT INTO pos.pos_tender (id, sale_id, method, status, amount, cash_received, change_amount, payment_id, accepted_by)
       VALUES ($1, $2, 'TUNAI', 'ACCEPTED', $3, $4, $5, $6, $7)`,
      [tenderId, input.saleId, saleRow.total, input.cashReceived, saleRow.change, payment.paymentId, input.acceptedBy],
    );
    await client.query("UPDATE pos.pos_sale SET status = 'PAID', paid_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [input.saleId]);

    await appendAuditEntry({
      organizationId: saleRow.organization_id, branchId: saleRow.branch_id, actor: input.actor,
      action: 'POS_TENDER_ACCEPTED',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: saleRow.version + 1 },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: 'PENDING_PAYMENT', after: 'PAID' },
        { path: 'tender.amount', classification: 'CONFIDENTIAL', after: saleRow.total },
        { path: 'tender.changeAmount', classification: 'CONFIDENTIAL', after: saleRow.change },
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });

    const cashReceived = await client.query<{ value: string }>('SELECT cash_received::text AS value FROM pos.pos_tender WHERE id = $1', [tenderId]);
    return {
      tenderId, paymentId: payment.paymentId, amount: saleRow.total, cashReceived: cashReceived.rows[0]!.value,
      changeAmount: saleRow.change, saleStatus: 'PAID' as const,
    };
  });
}
