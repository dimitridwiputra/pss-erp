import type { Pool } from 'pg';
import { z } from 'zod';
import { withAuditedTransaction } from '@pss/audit';
import { BusinessDateSchema, DomainError } from '@pss/contracts';
import { ActorInputSchema, SourceSchema } from './support/audit-context';

const DeliveredLineInputSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  // Matches sales.invoice_line.qty: numeric(18,3). "0" is treated the same as
  // omitting the line entirely — see the removal rule documented below.
  qtyDelivered: z.string().regex(/^\d+(\.\d{1,3})?$/),
});

const IssueInvoiceInputSchema = z.strictObject({
  invoiceId: z.uuid(),
  deliveredLines: z.array(DeliveredLineInputSchema),
  invoiceDate: BusinessDateSchema,
  actor: ActorInputSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: SourceSchema,
});
export type IssueInvoiceInput = z.input<typeof IssueInvoiceInputSchema>;

export interface IssuedInvoice {
  invoiceId: string;
  number: string;
  total: string;
  status: 'ISSUED';
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.',
  }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

/**
 * BIL-002 (narrowed): transitions a PREPARED/DRAFT invoice to ISSUED once goods
 * are handed over, recomputing lines/totals to match ONLY the delivered qty.
 *
 * Line-removal rule (documented per DOMAIN.md): a prepared line whose
 * product+uom is absent from `deliveredLines`, or present with qtyDelivered
 * "0", is deleted rather than kept at qty 0 — sales.invoice_line.qty has
 * CHECK (qty > 0), so a zeroed row is not a representable state under this
 * schema. A partially delivered line has its qty/line_total reduced to the
 * delivered amount. Issued invoices are immutable afterward (DEC-106): no
 * further command in this slice mutates an ISSUED invoice.
 *
 * This command always manages its own transaction (no shared-client overload):
 * issuance is the terminal step of the flow and is never expected to compose
 * inside a caller's own transaction the way `prepareInvoice` does.
 */
export async function issueInvoice(pool: Pool, rawInput: IssueInvoiceInput): Promise<IssuedInvoice> {
  const input = parseOrThrow(IssueInvoiceInputSchema, rawInput);

  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const invoiceResult = await client.query<{ organization_id: string; status: string }>(
      `SELECT organization_id, status FROM sales.invoice WHERE id = $1 FOR UPDATE`,
      [input.invoiceId],
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) throw new DomainError('NOT_FOUND');
    if (invoice.status !== 'PREPARED' && invoice.status !== 'DRAFT') {
      throw new DomainError('INVALID_STATE_TRANSITION');
    }

    const delivered = new Map<string, string>();
    for (const line of input.deliveredLines) delivered.set(`${line.productId}::${line.uom}`, line.qtyDelivered);

    const existingLines = await client.query<{ id: string; product_id: string; uom: string }>(
      `SELECT id, product_id, uom FROM sales.invoice_line WHERE invoice_id = $1`,
      [input.invoiceId],
    );
    for (const row of existingLines.rows) {
      const qtyDelivered = delivered.get(`${row.product_id}::${row.uom}`);
      if (qtyDelivered === undefined || Number(qtyDelivered) <= 0) {
        await client.query(`DELETE FROM sales.invoice_line WHERE id = $1`, [row.id]);
        continue;
      }
      // line_total is recomputed by Postgres from the delivered qty, never in JS.
      await client.query(
        `UPDATE sales.invoice_line SET qty = $2::numeric, line_total = $2::numeric * unit_price WHERE id = $1`,
        [row.id, qtyDelivered],
      );
    }

    const updated = await client.query<{ number: string; total: string; version: number }>(
      `UPDATE sales.invoice
       SET status = 'ISSUED',
           invoice_date = $2,
           subtotal = (SELECT COALESCE(SUM(line_total), 0) FROM sales.invoice_line WHERE invoice_id = $1),
           total = (SELECT COALESCE(SUM(line_total), 0) FROM sales.invoice_line WHERE invoice_id = $1),
           version = version + 1,
           updated_at = now()
       WHERE id = $1
       RETURNING number, total, version`,
      [input.invoiceId, input.invoiceDate],
    );
    const result = updated.rows[0];
    if (!result) throw new Error('Invoice issue update did not return a value.');

    await appendAuditEntry({
      organizationId: invoice.organization_id,
      actor: input.actor,
      action: 'INVOICE_ISSUED',
      entity: { domain: 'invoicing', type: 'Invoice', id: input.invoiceId, version: result.version },
      changes: [{ path: 'status', classification: 'INTERNAL', before: invoice.status, after: 'ISSUED' }],
      requestId: input.requestId,
      correlationId: input.correlationId,
      source: input.source,
    });

    return { invoiceId: input.invoiceId, number: result.number, total: result.total, status: 'ISSUED' as const };
  });
}
