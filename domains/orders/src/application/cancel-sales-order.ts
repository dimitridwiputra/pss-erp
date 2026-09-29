import { DomainError } from '@pss/contracts';
import { runAuditedWork, withAuditedTransaction, type AuditedTransaction } from '@pss/audit';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ActorInputSchema } from './shared-schemas';

// Terminal STM-SalesOrder states (docs/PRODUCT_PRD.md Appendix E): cancelling from any of
// these is not a valid transition.
const TERMINAL_STATUSES = new Set(['CANCELLED', 'REJECTED', 'COMPLETED']);

const CancelSalesOrderInputSchema = z.strictObject({
  salesOrderId: z.uuid(),
  reasonCode: z.string().min(1),
  actor: ActorInputSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});

export type CancelSalesOrderInput = z.input<typeof CancelSalesOrderInputSchema>;

export interface CancelSalesOrderResult {
  salesOrderId: string;
  status: string;
}

/**
 * Cancels a sales order that is not already in a terminal state. Throws
 * INVALID_STATE_TRANSITION (HTTP 409, Appendix F.1) if the order is already
 * CANCELLED, REJECTED, or COMPLETED.
 */
export async function cancelSalesOrder(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: CancelSalesOrderInput,
): Promise<CancelSalesOrderResult> {
  const parsed = CancelSalesOrderInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  const input = parsed.data;

  const work = async (transaction: AuditedTransaction): Promise<CancelSalesOrderResult> => {
    const current = await transaction.client.query<{
      organization_id: string;
      branch_id: string;
      status: string;
      version: number;
    }>(
      `SELECT organization_id, branch_id, status, version FROM sales.sales_order WHERE id = $1 FOR UPDATE`,
      [input.salesOrderId],
    );
    const row = current.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (TERMINAL_STATUSES.has(row.status)) throw new DomainError('INVALID_STATE_TRANSITION');

    await transaction.client.query(
      `UPDATE sales.sales_order SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
      [input.salesOrderId],
    );

    await transaction.appendAuditEntry({
      organizationId: row.organization_id,
      branchId: row.branch_id,
      actor: input.actor,
      action: 'SALES_ORDER_CANCELLED',
      entity: { domain: 'orders', type: 'SalesOrder', id: input.salesOrderId, version: row.version },
      changes: [{ path: 'status', classification: 'INTERNAL', before: row.status, after: 'CANCELLED' }],
      reasonCode: input.reasonCode,
      requestId: input.requestId,
      correlationId: input.correlationId,
      source: input.source,
    });

    return { salesOrderId: input.salesOrderId, status: 'CANCELLED' };
  };

  return client ? runAuditedWork(client, work) : withAuditedTransaction(pool, work);
}
