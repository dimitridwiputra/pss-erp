import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AuditedTransaction } from '@pss/audit';
import { BusinessDateSchema, DomainError } from '@pss/contracts';
import { ActorInputSchema, SourceSchema } from './support/audit-context';
import { withConnection } from '@pss/platform';
import { calculateSalesTax } from '@pss/tax';
import { getCustomerTaxTreatment, getProductTaxCodes } from '@pss/master-data';

const PrepareInvoiceLineInputSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  // Matches sales.invoice_line.qty: numeric(18,3), CHECK (qty > 0).
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/).refine((value) => !/^0+(\.0+)?$/.test(value), 'Qty must be greater than zero.'),
  // Matches sales.invoice_line.unit_price: numeric(18,2).
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
});

const PrepareInvoiceInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchCode: z.string().min(1),
  salesOrderId: z.uuid(),
  // Stored so INVOICE_ISSUED is built from the invoice itself (MVP_PLAN §5). A POS invoice must
  // carry its branch: the v1 event has no optional branch.
  channel: z.literal('POS').optional(),
  branchId: z.uuid().optional(),
  /**
   * The customer being invoiced, whose tax treatment decides a line's code (TAX-002).
   *
   * Required rather than optional on purpose. A sale with no customer has no tax treatment, and
   * defaulting one is precisely the silently zero-taxed invoice this command used to produce
   * (TAX-001.AC02, TAX-002.E1). POS-004 already resolves a walk-in customer before checkout, so a
   * caller always has one to name.
   */
  customerId: z.uuid(),
  /**
   * The document's business date in Asia/Jakarta (AGENTS.md §11.1), which is the date the applicable
   * rate is chosen by (TAX-001.BR01). Optional and defaulting to today in that zone: a same-day sale
   * is the ordinary case, and the default is that case rather than a rule. A backdated or
   * future-dated invoice passes its own date and is taxed by it.
   */
  businessDate: BusinessDateSchema.optional(),
  lines: z.array(PrepareInvoiceLineInputSchema).min(1),
  actor: ActorInputSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: SourceSchema,
}).refine((input) => input.channel !== 'POS' || input.branchId !== undefined, {
  path: ['branchId'], message: 'A POS invoice needs its branch.',
});
export type PrepareInvoiceInput = z.input<typeof PrepareInvoiceInputSchema>;

export interface PreparedInvoice {
  invoiceId: string;
  number: string;
  subtotal: string;
  taxTotal: string;
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

/**
 * Business date is interpreted Asia/Jakarta (AGENTS.md §11.1) while timestamps stay UTC, so the
 * zone is formatted rather than offset-arithmetic'd: a fixed `-07:00` would be wrong for any year
 * Jakarta is not on that offset.
 */
const jakartaDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' });

/** Today's date in the business zone, used when a caller does not state the document's date. */
export function currentJakartaBusinessDate(): string {
  return jakartaDateFormatter.format(new Date());
}

const jakartaYearFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric' });

/**
 * The year an invoice number is reserved in (DOC-001 resets the sequence per organization/year).
 *
 * Taken from the document's own business date so a backdated invoice is numbered for the year it is
 * dated in — the same date its rate was chosen by, so the number and the tax cannot disagree.
 */
function jakartaYear(businessDate: string): number {
  return Number.parseInt(jakartaYearFormatter.format(new Date(`${businessDate}T00:00:00+07:00`)), 10);
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

/**
 * Each line's net amount, rounded to money scale by PostgreSQL rather than by JavaScript.
 *
 * This is the tax base as well as the line total: TAX-002.BR01 defines the DPP as the net line amount
 * after discount, and invoicing has no discount model yet (see DOMAIN.md open decisions), so the two
 * are the same figure. Computing it in SQL is what keeps a float from touching money (AGENTS.md §6,
 * DB.R04) — and computing it once means the tax and the line total cannot disagree by a rounding.
 */
async function computeLineTotals(
  client: PoolClient,
  lines: ReadonlyArray<z.output<typeof PrepareInvoiceLineInputSchema>>,
): Promise<string[]> {
  const totals = await client.query<{ line_total: string }>(
    `SELECT ROUND(qty * unit_price, 2)::text AS line_total
     FROM unnest($1::numeric[], $2::numeric[]) AS l(qty, unit_price)`,
    [lines.map((line) => line.qty), lines.map((line) => line.unitPrice)],
  );
  if (totals.rows.length !== lines.length) {
    throw new Error('The invoice line totals did not cover every line.');
  }
  return totals.rows.map((row) => row.line_total);
}

/**
 * BIL-001: reserves an invoice number and creates the invoice PREPARED with its lines.
 *
 * The tax is resolved before anything is written and stored as a snapshot on each line
 * (TAX-002.BR03), so `tax_total` is the real PPN rather than a zero placeholder, and a later change
 * to the rate or the rounding rule cannot alter this document. The customer's treatment and the
 * products' codes are read through `@pss/master-data`'s public functions rather than from `core.*`
 * (AGENTS.md §3.1); the resolution itself is `@pss/tax`'s. Invoicing holds no tax rule — it supplies
 * quantities and prices, and stores what it is told.
 *
 * Resolution, the inserts, the audit entry and the header totals share one transaction (ADR-0013,
 * DB.R09). A resolution that cannot be made throws before the number is reserved, so a rejected
 * invoice leaves neither a partial row nor a burned number.
 */
async function insertPreparedInvoice(
  pool: Pool,
  transaction: AuditedTransaction,
  input: z.output<typeof PrepareInvoiceInputSchema> & { businessDate: string },
): Promise<PreparedInvoice> {
  const { client, appendAuditEntry } = transaction;
  const year = jakartaYear(input.businessDate);
  const number = await nextInvoiceNumber(pool, client, {
    organizationId: input.organizationId,
    branchCode: input.branchCode,
    year,
  });

  const lineTotals = await computeLineTotals(client, input.lines);
  const [customerTaxTreatment, productTaxCodes] = await Promise.all([
    getCustomerTaxTreatment(pool, client, {
      customerId: input.customerId,
      organizationId: input.organizationId,
    }),
    getProductTaxCodes(pool, client, {
      productIds: input.lines.map((line) => line.productId),
      organizationId: input.organizationId,
    }),
  ]);

  const calculated = await calculateSalesTax(pool, client, {
    organizationId: input.organizationId,
    businessDate: input.businessDate,
    customerTaxTreatment,
    lines: input.lines.map((line, index) => ({
      productId: line.productId,
      uom: line.uom,
      taxBase: lineTotals[index] ?? '0',
      productTaxCode: productTaxCodes.get(line.productId) ?? null,
    })),
  });

  const invoiceId = randomUUID();
  await client.query(
    `INSERT INTO sales.invoice (
      id, organization_id, sales_order_id, number, status, tax_rounding_rule, channel, customer_id, branch_id
    ) VALUES ($1, $2, $3, $4, 'PREPARED', $5, $6, $7, $8)`,
    [invoiceId, input.organizationId, input.salesOrderId, number, calculated.roundingRule,
      input.channel ?? null, input.customerId, input.branchId ?? null],
  );

  for (const [index, line] of input.lines.entries()) {
    const tax = calculated.lines[index];
    if (!tax) throw new Error('The tax resolution did not cover every invoice line.');
    await client.query(
      `INSERT INTO sales.invoice_line (
        id, invoice_id, product_id, uom, qty, unit_price, tax_code, tax_rate, tax_base,
        tax_rounding_rule, tax_amount, line_total
      ) VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8::numeric, $9::numeric,
                $10, $11::numeric, $12::numeric)`,
      [randomUUID(), invoiceId, line.productId, line.uom, line.qty, line.unitPrice,
        tax.taxCode, tax.rate, tax.taxBase, tax.roundingRule, tax.taxAmount, lineTotals[index]],
    );
  }

  // Server-side SUM keeps subtotal/tax_total/total decimal-exact, and the total now includes tax:
  // an invoice whose tax_total is excluded from its own total is not an invoice.
  const totals = await client.query<{ subtotal: string; tax_total: string; total: string }>(
    `UPDATE sales.invoice
     SET subtotal = (SELECT COALESCE(SUM(line_total), 0) FROM sales.invoice_line WHERE invoice_id = $1),
         tax_total = (SELECT COALESCE(SUM(tax_amount), 0) FROM sales.invoice_line WHERE invoice_id = $1),
         total = (SELECT COALESCE(SUM(line_total + tax_amount), 0) FROM sales.invoice_line WHERE invoice_id = $1),
         updated_at = now()
     WHERE id = $1
     RETURNING subtotal::text, tax_total::text, total::text`,
    [invoiceId],
  );
  const row = totals.rows[0];
  if (!row) throw new Error('Invoice total update did not return a value.');

  await appendAuditEntry({
    organizationId: input.organizationId,
    actor: input.actor,
    action: 'INVOICE_PREPARED',
    entity: { domain: 'invoicing', type: 'Invoice', id: invoiceId, version: 1 },
    changes: [
      { path: 'status', classification: 'INTERNAL', after: 'PREPARED' },
      { path: 'number', classification: 'INTERNAL', after: number },
      // The rate and the rounding rule belong on the document, not only in the environment:
      // TAX-002's audit requirement says the tax configuration a document used is recorded with it,
      // and without this an entry cannot explain the tax_total printed next to it.
      { path: 'taxTotal', classification: 'INTERNAL', after: row.tax_total },
      { path: 'taxRoundingRule', classification: 'INTERNAL', after: calculated.roundingRule ?? 'NONE' },
    ],
    requestId: input.requestId,
    correlationId: input.correlationId,
    source: input.source,
  });

  return { invoiceId, number, subtotal: row.subtotal, taxTotal: row.tax_total, total: row.total };
}

export async function prepareInvoice(pool: Pool, client: PoolClient | undefined, rawInput: PrepareInvoiceInput): Promise<PreparedInvoice> {
  const input = parseOrThrow(PrepareInvoiceInputSchema, rawInput);

  return withConnection(pool, client, (transaction) => insertPreparedInvoice(pool, transaction, {
    ...input,
    businessDate: input.businessDate ?? currentJakartaBusinessDate(),
  }));
}