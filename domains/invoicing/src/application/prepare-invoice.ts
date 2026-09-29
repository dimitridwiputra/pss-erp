import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';
import { ActorInputSchema, SourceSchema } from './support/audit-context';
import { withConnection } from './support/with-connection';

/**
 * POS-005 (E2) and TAX-001/TAX-002 require invoicing to reject preparation when
 * no PPN rate is configured (`INVOICE_BLOCKED`, §46A, already registered in
 * packages/contracts). The `tax` domain does not exist yet, so there is no rate
 * to check — OD-112 (docs/PRODUCT_PRD.md, "PSS PKP status & tarif") tracks this
 * as an explicit open gap. This guard is a documented no-op stub: it always
 * passes, and `tax_total` is stored as 0 by every command in this file. Do not
 * fabricate a tax result; wire the real `tax` domain check here once OD-112 is
 * resolved and TAX-001 ships (see domains/invoicing/DOMAIN.md "Open decisions").
 */
function assertTaxConfigured(): void {
  // Deferred: tax domain / OD-112 not yet implemented.
}

const PrepareInvoiceLineInputSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  // Matches sales.invoice_line.qty: numeric(18,3), CHECK (qty > 0).
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/).refine((value) => Number(value) > 0, 'Qty must be greater than zero.'),
  // Matches sales.invoice_line.unit_price: numeric(18,2).
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
});

const PrepareInvoiceInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchCode: z.string().min(1),
  salesOrderId: z.uuid(),
  lines: z.array(PrepareInvoiceLineInputSchema).min(1),
  actor: ActorInputSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: SourceSchema,
});
export type PrepareInvoiceInput = z.input<typeof PrepareInvoiceInputSchema>;

export interface PreparedInvoice {
  invoiceId: string;
  number: string;
  total: string;
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.',
  }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

// Business date is interpreted Asia/Jakarta (AGENTS.md §11.1); invoice numbering
// resets per organization/year (DOC-001), so the year must use the WIB calendar
// date rather than the server's UTC date.
const jakartaYearFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric' });
function currentJakartaYear(): number {
  return Number.parseInt(jakartaYearFormatter.format(new Date()), 10);
}

/**
 * Atomically reserves the next sequence value for (organizationId, year) and
 * formats it as `INV-{branchCode}-{year}-{000000}` (POS-005 example:
 * `INV-CMH-2027-000123`). The single INSERT ... ON CONFLICT ... DO UPDATE
 * statement increments and returns the new value in one round trip, so two
 * concurrent callers for the same organization/year never observe or reserve
 * the same number.
 */
async function nextInvoiceNumber(
  pool: Pool,
  client: PoolClient | undefined,
  input: { organizationId: string; branchCode: string; year: number },
): Promise<string> {
  const executor = client ?? pool;
  const result = await executor.query<{ last_value: number }>(
    `INSERT INTO sales.invoice_number_sequence (organization_id, year, last_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (organization_id, year)
     DO UPDATE SET last_value = sales.invoice_number_sequence.last_value + 1
     RETURNING last_value`,
    [input.organizationId, input.year],
  );
  const lastValue = result.rows[0]?.last_value;
  if (lastValue === undefined) throw new Error('Invoice number sequence did not return a value.');
  return `INV-${input.branchCode}-${input.year}-${String(lastValue).padStart(6, '0')}`;
}

async function insertPreparedInvoice(
  pool: Pool,
  transaction: AuditedTransaction,
  input: z.output<typeof PrepareInvoiceInputSchema>,
): Promise<PreparedInvoice> {
  const { client, appendAuditEntry } = transaction;
  const year = currentJakartaYear();
  const number = await nextInvoiceNumber(pool, client, {
    organizationId: input.organizationId,
    branchCode: input.branchCode,
    year,
  });

  const invoiceId = randomUUID();
  await client.query(
    `INSERT INTO sales.invoice (
      id, organization_id, sales_order_id, number, status, tax_total
    ) VALUES ($1, $2, $3, $4, 'PREPARED', 0)`,
    [invoiceId, input.organizationId, input.salesOrderId, number],
  );

  for (const line of input.lines) {
    // qty * unit_price is computed by Postgres (numeric), never in JS, so no
    // float/decimal-string arithmetic primitive is written here (AGENTS.md §6).
    await client.query(
      `INSERT INTO sales.invoice_line (
        id, invoice_id, product_id, uom, qty, unit_price, tax_amount, line_total
      ) VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, 0, $5::numeric * $6::numeric)`,
      [randomUUID(), invoiceId, line.productId, line.uom, line.qty, line.unitPrice],
    );
  }

  // Server-side SUM keeps subtotal/total decimal-exact.
  const totals = await client.query<{ total: string }>(
    `UPDATE sales.invoice
     SET subtotal = (SELECT COALESCE(SUM(qty * unit_price), 0) FROM sales.invoice_line WHERE invoice_id = $1),
         total = (SELECT COALESCE(SUM(qty * unit_price), 0) FROM sales.invoice_line WHERE invoice_id = $1),
         updated_at = now()
     WHERE id = $1
     RETURNING total`,
    [invoiceId],
  );
  const total = totals.rows[0]?.total;
  if (total === undefined) throw new Error('Invoice total update did not return a value.');

  await appendAuditEntry({
    organizationId: input.organizationId,
    actor: input.actor,
    action: 'INVOICE_PREPARED',
    entity: { domain: 'invoicing', type: 'Invoice', id: invoiceId, version: 1 },
    changes: [
      { path: 'status', classification: 'INTERNAL', after: 'PREPARED' },
      { path: 'number', classification: 'INTERNAL', after: number },
    ],
    requestId: input.requestId,
    correlationId: input.correlationId,
    source: input.source,
  });

  return { invoiceId, number, total };
}

/**
 * BIL-001: reserves an invoice number and creates the invoice PREPARED with its
 * lines. `tax_total` is always stored as 0 in this slice — see
 * `assertTaxConfigured` above and OD-112. Pass an open transaction's `client`
 * to run inside a caller-owned transaction (e.g. POS's own checkout
 * transaction); omit it to let this command manage its own transaction.
 */
export async function prepareInvoice(pool: Pool, client: PoolClient | undefined, rawInput: PrepareInvoiceInput): Promise<PreparedInvoice> {
  const input = parseOrThrow(PrepareInvoiceInputSchema, rawInput);
  assertTaxConfigured();

  return withConnection(pool, client, (transaction) => insertPreparedInvoice(pool, transaction, input));
}
