import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { BusinessDateSchema, DomainError, newEventId } from '@pss/contracts';
import { appendOutboxEvent, withConnection } from '@pss/platform';
import { resolveSalesTaxOnSnapshot, SalesTaxSnapshotSchema } from '@pss/tax';
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
  subtotal: string;
  taxTotal: string;
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

interface PreparedLineRow {
  id: string;
  product_id: string;
  uom: string;
  tax_code: string | null;
  tax_rate: string | null;
  tax_rounding_rule: string | null;
}

/**
 * BIL-002 (narrowed): transitions a PREPARED/DRAFT invoice to ISSUED once goods are handed over,
 * recomputing lines/totals to match ONLY the delivered qty.
 *
 * Line-removal rule (documented per DOMAIN.md): a prepared line whose product+uom is absent from
 * `deliveredLines`, or present with qtyDelivered "0", is deleted rather than kept at qty 0 —
 * sales.invoice_line.qty has CHECK (qty > 0), so a zeroed row is not a representable state under
 * this schema. A partially delivered line has its qty/line_total reduced to the delivered amount.
 * Issued invoices are immutable afterward (DEC-106): no further command in this slice mutates an
 * ISSUED invoice.
 *
 * The tax of a re-quantified line is recomputed from the snapshot the line already carries
 * (`resolveSalesTaxOnSnapshot`), never from the rate in force now. That is what makes TAX-002.NC01
 * hold: a rate change between preparing and issuing adjusts the amount for the quantity actually
 * handed over, but it cannot re-price the document at a rate the customer was never quoted.
 *
 * A line whose snapshot is NULL was written before tax resolution existed. Issuing it is refused:
 * its tax was never computed, and issuing it would publish exactly the zero-taxed invoice this
 * change removed. The operator's route is to prepare a new invoice, not to issue this one.
 *
 * Pass an open transaction's `client` to compose with the caller: POS pickup handover issues the
 * invoice in the same commit as the delivery and the stock issue (POS-010.R02), so a failure in
 * any step leaves none of them applied.
 *
 * A POS-channel invoice publishes INVOICE_ISSUED v1 through the outbox in this same transaction,
 * built from the stored invoice. Other channels have no v1 payload yet (MVP_PLAN §5 is POS-only)
 * and publish nothing; see DOMAIN.md.
 */
export async function issueInvoice(pool: Pool, client: PoolClient | undefined, rawInput: IssueInvoiceInput): Promise<IssuedInvoice> {
  const input = parseOrThrow(IssueInvoiceInputSchema, rawInput);

  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
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

    const existingLines = await client.query<PreparedLineRow>(
      `SELECT id, product_id, uom, tax_code, tax_rate::text AS tax_rate, tax_rounding_rule
       FROM sales.invoice_line WHERE invoice_id = $1`,
      [input.invoiceId],
    );
    for (const row of existingLines.rows) {
      const qtyDelivered = delivered.get(`${row.product_id}::${row.uom}`);
      if (qtyDelivered === undefined || /^0+(\.0+)?$/.test(qtyDelivered)) {
        await client.query(`DELETE FROM sales.invoice_line WHERE id = $1`, [row.id]);
        continue;
      }
      if (row.tax_code === null || row.tax_rate === null) {
        throw new DomainError('TAX_RATE_NOT_CONFIGURED', ['Hubungi Finance'], [{
          path: `lines.${row.product_id}.taxCode`, code: 'snapshot_missing',
          message: 'Invoice ini dibuat sebelum perhitungan pajak tersedia. Siapkan invoice baru.',
        }]);
      }
      const snapshot = SalesTaxSnapshotSchema.safeParse({
        taxCode: row.tax_code, rate: row.tax_rate, roundingRule: row.tax_rounding_rule,
      });
      if (!snapshot.success) {
        throw new DomainError('TAX_CODE_MISSING', ['Lengkapi Produk'], [{
          path: `lines.${row.product_id}.taxCode`, code: 'unsupported_value',
          message: 'Kode atau tarif pajak pada baris invoice tidak dikenali.',
        }]);
      }

      // line_total and tax_base are recomputed by Postgres from the delivered qty, never in JS.
      const recomputed = await client.query<{ line_total: string; tax_base: string }>(
        `SELECT ROUND($2::numeric * unit_price, 2)::text AS line_total,
                ROUND($2::numeric * unit_price, 2)::text AS tax_base
         FROM sales.invoice_line WHERE id = $1`,
        [row.id, qtyDelivered],
      );
      const amounts = recomputed.rows[0];
      if (!amounts) throw new Error('The invoice line amount was not returned after recomputation.');

      const tax = resolveSalesTaxOnSnapshot({ taxBase: amounts.tax_base, snapshot: snapshot.data });
      await client.query(
        `UPDATE sales.invoice_line
         SET qty = $2::numeric, line_total = $3::numeric, tax_base = $3::numeric, tax_amount = $4::numeric
         WHERE id = $1`,
        [row.id, qtyDelivered, amounts.line_total, tax.taxAmount],
      );
    }

    const updated = await client.query<{
      number: string; subtotal: string; tax_total: string; total: string; version: number;
      channel: string | null; customer_id: string | null; branch_id: string | null; sales_order_id: string;
    }>(
      `UPDATE sales.invoice
       SET status = 'ISSUED',
           invoice_date = $2,
           subtotal = (SELECT COALESCE(SUM(line_total), 0) FROM sales.invoice_line WHERE invoice_id = $1),
           tax_total = (SELECT COALESCE(SUM(tax_amount), 0) FROM sales.invoice_line WHERE invoice_id = $1),
           total = (SELECT COALESCE(SUM(line_total + tax_amount), 0) FROM sales.invoice_line WHERE invoice_id = $1),
           version = version + 1,
           updated_at = now()
       WHERE id = $1
       RETURNING number, subtotal::text, tax_total::text, total::text, version,
                 channel, customer_id, branch_id, sales_order_id`,
      [input.invoiceId, input.invoiceDate],
    );
    const result = updated.rows[0];
    if (!result) throw new Error('Invoice issue update did not return a value.');

    await appendAuditEntry({
      organizationId: invoice.organization_id,
      actor: input.actor,
      action: 'INVOICE_ISSUED',
      entity: { domain: 'invoicing', type: 'Invoice', id: input.invoiceId, version: result.version },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: invoice.status, after: 'ISSUED' },
        // Re-quantifying a line moves the tax with it, so the document's tax total is part of what
        // this command changed (AGENTS.md §14: a material diff, not just the state transition).
        { path: 'taxTotal', classification: 'INTERNAL', after: result.tax_total },
      ],
      requestId: input.requestId,
      correlationId: input.correlationId,
      source: input.source,
    });

    if (result.channel === 'POS') {
      if (!result.customer_id || !result.branch_id) throw new Error('A POS invoice was stored without its customer or branch.');
      await appendOutboxEvent(client, {
        eventId: newEventId(), eventType: 'INVOICE_ISSUED', eventVersion: 1,
        occurredAt: new Date().toISOString(), businessDate: input.invoiceDate,
        organizationId: invoice.organization_id, branchId: result.branch_id,
        aggregateType: 'Invoice', aggregateId: input.invoiceId, aggregateVersion: result.version,
        producer: 'invoicing', actor: input.actor,
        correlationId: input.correlationId, causationId: input.requestId,
        payload: {
          invoiceId: input.invoiceId, invoiceNumber: result.number, customerId: result.customer_id,
          branchId: result.branch_id, salesOrderId: result.sales_order_id, channel: 'POS', currency: 'IDR',
          subtotal: result.subtotal, taxAmount: result.tax_total, total: result.total, businessDate: input.invoiceDate,
        },
      });
    }

    return {
      invoiceId: input.invoiceId,
      number: result.number,
      subtotal: result.subtotal,
      taxTotal: result.tax_total,
      total: result.total,
      status: 'ISSUED' as const,
    };
  });
}