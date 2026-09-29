import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const PrintPosReceiptSchema = z.strictObject({ saleId: z.uuid(), printedBy: z.uuid(), reprintReason: z.string().min(1).optional() });
export type PrintPosReceiptInput = z.input<typeof PrintPosReceiptSchema>;

export interface PosReceiptPrint { id: string; saleId: string; copyNumber: number }

/**
 * POS-011: the first print for a sale is copy 1 (the original ticket); every print after that is a
 * reprint and must be tagged "SALINAN <n>" by the caller (the copy_number returned here IS that n).
 * A reprint beyond the first requires a reason (POS-011.EXCEPTION E1).
 */
export async function printPosReceipt(pool: Pool, raw: PrintPosReceiptInput): Promise<PosReceiptPrint> {
  const input = parseOrThrow(PrintPosReceiptSchema, raw);
  const sale = await pool.query<{ status: string }>('SELECT status FROM pos.pos_sale WHERE id = $1', [input.saleId]);
  const status = sale.rows[0]?.status;
  if (!status) throw new DomainError('NOT_FOUND');
  if (status !== 'PAID' && status !== 'CREDIT_APPROVED' && status !== 'HANDED_OVER') throw new DomainError('POS_NOT_PAID');

  const priorCount = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pos.pos_receipt_print WHERE sale_id = $1', [input.saleId]);
  const copyNumber = Number.parseInt(priorCount.rows[0]?.count ?? '0', 10) + 1;
  if (copyNumber > 1 && !input.reprintReason) {
    throw new DomainError('VALIDATION_FAILED', [], [{ path: 'reprintReason', code: 'required', message: 'Alasan diperlukan untuk cetak ulang.' }]);
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO pos.pos_receipt_print (id, sale_id, copy_number, printed_by, reason) VALUES ($1, $2, $3, $4, $5)`,
    [id, input.saleId, copyNumber, input.printedBy, input.reprintReason ?? null],
  );
  return { id, saleId: input.saleId, copyNumber };
}
