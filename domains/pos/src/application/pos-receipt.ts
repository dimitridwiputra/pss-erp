import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { getPosReceipt, type PosReceipt } from './queries';
import { parseOrThrow, RequestMetaShape } from './support/command-input';

const PrintPosReceiptSchema = z.strictObject({
  saleId: z.uuid(), printedBy: z.uuid(), reprintReason: z.string().trim().min(1).max(200).optional(),
  ...RequestMetaShape,
});
export type PrintPosReceiptInput = z.input<typeof PrintPosReceiptSchema>;

/**
 * POS-011: the first print for a sale is copy 1 (the original ticket); every print after that is a
 * reprint, marked "SALINAN" with its copy number, and must give a reason (POS-011 E1). The sale is
 * locked so two concurrent prints cannot both claim the same copy number.
 */
export async function printPosReceipt(pool: Pool, client: PoolClient | undefined, raw: PrintPosReceiptInput): Promise<PosReceipt> {
  const input = parseOrThrow(PrintPosReceiptSchema, raw);
  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const sale = await client.query<{ status: string; organization_id: string; branch_id: string; prior: number }>(
      `SELECT sale.status, sale.organization_id, t.branch_id,
              (SELECT count(*)::int FROM pos.pos_receipt_print p WHERE p.sale_id = sale.id) AS prior
       FROM pos.pos_sale sale JOIN pos.pos_terminal t ON t.id = sale.terminal_id WHERE sale.id = $1 FOR UPDATE OF sale`,
      [input.saleId],
    );
    const row = sale.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status !== 'PAID' && row.status !== 'CREDIT_APPROVED' && row.status !== 'HANDED_OVER') throw new DomainError('POS_NOT_PAID');

    const copyNumber = row.prior + 1;
    if (copyNumber > 1 && !input.reprintReason) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'reprintReason', code: 'required', message: 'Alasan diperlukan untuk cetak ulang.' }]);
    }
    const id = randomUUID();
    await client.query(
      'INSERT INTO pos.pos_receipt_print (id, sale_id, copy_number, printed_by, reason) VALUES ($1, $2, $3, $4, $5)',
      [id, input.saleId, copyNumber, input.printedBy, copyNumber > 1 ? input.reprintReason ?? null : null],
    );
    await appendAuditEntry({
      organizationId: row.organization_id, branchId: row.branch_id, actor: input.actor,
      action: copyNumber === 1 ? 'POS_RECEIPT_PRINTED' : 'POS_RECEIPT_REPRINTED',
      entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: 1 },
      changes: [
        { path: 'receipt.copyNumber', classification: 'INTERNAL', after: String(copyNumber) },
        ...(copyNumber > 1 && input.reprintReason ? [{ path: 'receipt.reason', classification: 'INTERNAL' as const, after: input.reprintReason }] : []),
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
    const receipt = await getPosReceipt(client, input.saleId);
    if (!receipt) throw new DomainError('NOT_FOUND');
    return receipt;
  });
}
