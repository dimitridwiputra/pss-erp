import { randomUUID } from 'node:crypto';
import { DomainError } from '@pss/contracts';
import { runAuditedWork, withAuditedTransaction, type AuditedTransaction } from '@pss/audit';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ActorInputSchema } from './shared-schemas';

const RequestSalesOrderLineInputSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  // Matches sales.sales_order_line.qty: numeric(18,3), CHECK (qty > 0).
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/).refine((value) => !/^0+(\.0+)?$/.test(value), 'qty must be greater than zero'),
  // Matches sales.sales_order_line.unit_price: numeric(18,2), non-negative.
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
});

const IdempotencyKeyInputSchema = z.strictObject({
  key: z.string().min(1),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const RequestSalesOrderInputSchema = z.strictObject({
  organizationId: z.uuid(),
  // identityId and idempotencyKey are accepted for parity with the platform command envelope
  // (see @pss/platform's withIdempotentCommand). They are validated but not used by this
  // command's own idempotency mechanism, which relies solely on the (organizationId, clientKey)
  // unique constraint below — see the module doc comment on requestSalesOrder.
  identityId: z.uuid(),
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  customerId: z.uuid(),
  orderSource: z.string().min(1),
  sourceApplication: z.string().min(1),
  handoverMode: z.enum(['DELIVERY', 'CUSTOMER_PICKUP']),
  clientKey: z.string().min(1).max(200),
  lines: z.array(RequestSalesOrderLineInputSchema).min(1),
  idempotencyKey: IdempotencyKeyInputSchema,
  actor: ActorInputSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});

export type RequestSalesOrderInput = z.input<typeof RequestSalesOrderInputSchema>;
type ValidatedRequestSalesOrderInput = z.output<typeof RequestSalesOrderInputSchema>;

export interface RequestSalesOrderResult {
  salesOrderId: string;
  status: string;
  total: string;
  replayed: boolean;
}

interface SalesOrderRow {
  id: string;
  status: string;
  total: string;
}

function toResult(row: SalesOrderRow, replayed: boolean): RequestSalesOrderResult {
  return { salesOrderId: row.id, status: row.status, total: row.total, replayed };
}

async function findExistingOrder(
  queryable: Pool | PoolClient,
  organizationId: string,
  clientKey: string,
): Promise<SalesOrderRow | undefined> {
  const result = await queryable.query<SalesOrderRow>(
    `SELECT id, status, total FROM sales.sales_order WHERE organization_id = $1 AND client_key = $2`,
    [organizationId, clientKey],
  );
  return result.rows[0];
}

function isUniqueViolationError(error: unknown): boolean {
  // node-pg surfaces the PostgreSQL SQLSTATE as a plain `code` property, not a typed error class.
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/**
 * Inserts the order as REQUESTED, inserts its lines, computes the total server-side
 * (Postgres SUM over numeric(18,2) line totals — never JS floating point), confirms the
 * order (REQUESTED -> CONFIRMED), and writes exactly one audit entry.
 *
 * This minimal slice skips VALIDATED and credit-hold/reservation-partial branching: the
 * caller (e.g. domains/pos) is responsible for having already resolved credit, price, and
 * stock reservation before calling requestSalesOrder.
 */
async function performInsert(
  transaction: AuditedTransaction,
  input: ValidatedRequestSalesOrderInput,
): Promise<SalesOrderRow> {
  const orderId = randomUUID();
  // A concurrent request for the same (organizationId, clientKey) throws 23505 here;
  // the caller recovers by re-selecting and returning the winning row instead of throwing.
  await transaction.client.query(
    `INSERT INTO sales.sales_order (
       id, organization_id, branch_id, warehouse_id, customer_id,
       order_source, source_application, handover_mode, status, client_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REQUESTED', $9)`,
    [
      orderId, input.organizationId, input.branchId, input.warehouseId, input.customerId,
      input.orderSource, input.sourceApplication, input.handoverMode, input.clientKey,
    ],
  );

  for (const line of input.lines) {
    await transaction.client.query(
      `INSERT INTO sales.sales_order_line (
         id, sales_order_id, product_id, uom, qty, unit_price, line_total
       ) VALUES ($1, $2, $3, $4, $5, $6, $5::numeric * $6::numeric)`,
      [randomUUID(), orderId, line.productId, line.uom, line.qty, line.unitPrice],
    );
  }

  const confirmed = await transaction.client.query<SalesOrderRow>(
    `UPDATE sales.sales_order
        SET status = 'CONFIRMED',
            total = (SELECT COALESCE(SUM(line_total), 0) FROM sales.sales_order_line WHERE sales_order_id = $1),
            updated_at = now()
      WHERE id = $1
      RETURNING id, status, total`,
    [orderId],
  );
  const row = confirmed.rows[0];
  if (!row) throw new Error('Sales order confirmation update did not return a row.');

  await transaction.appendAuditEntry({
    organizationId: input.organizationId,
    branchId: input.branchId,
    actor: input.actor,
    action: 'SALES_ORDER_CONFIRMED',
    entity: { domain: 'orders', type: 'SalesOrder', id: orderId, version: 1 },
    changes: [{ path: 'status', classification: 'INTERNAL', before: 'REQUESTED', after: 'CONFIRMED' }],
    requestId: input.requestId,
    correlationId: input.correlationId,
    source: input.source,
  });

  return row;
}

/**
 * Turns a counter sale (or any P0 synchronous request) into a canonical, CONFIRMED sales
 * order. Idempotent on (organizationId, clientKey): a caller may call this twice with the
 * same clientKey (e.g. domains/pos's posSaleId) and always gets back the same order.
 *
 * Idempotency is implemented directly against the sales_order table rather than via
 * @pss/platform's withIdempotentCommand: that helper is a generic command-envelope
 * mechanism with its own bookkeeping table (platform.idempotency_key) scoped by
 * commandName + key, and layering it on top of the (organizationId, clientKey) unique
 * constraint here would duplicate the de-dup mechanism for no benefit.
 */
export async function requestSalesOrder(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: RequestSalesOrderInput,
): Promise<RequestSalesOrderResult> {
  const parsed = RequestSalesOrderInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  const input = parsed.data;

  const existing = await findExistingOrder(client ?? pool, input.organizationId, input.clientKey);
  if (existing) return toResult(existing, true);

  if (client) {
    await client.query('SAVEPOINT request_sales_order');
    try {
      const row = await runAuditedWork(client, (transaction) => performInsert(transaction, input));
      await client.query('RELEASE SAVEPOINT request_sales_order');
      return toResult(row, false);
    } catch (error) {
      if (isUniqueViolationError(error)) {
        await client.query('ROLLBACK TO SAVEPOINT request_sales_order');
        const winner = await findExistingOrder(client, input.organizationId, input.clientKey);
        if (winner) return toResult(winner, true);
      }
      throw error;
    }
  }

  try {
    const row = await withAuditedTransaction(pool, (transaction) => performInsert(transaction, input));
    return toResult(row, false);
  } catch (error) {
    if (isUniqueViolationError(error)) {
      const winner = await findExistingOrder(pool, input.organizationId, input.clientKey);
      if (winner) return toResult(winner, true);
    }
    throw error;
  }
}
