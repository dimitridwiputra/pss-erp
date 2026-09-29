import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';

const ExceptionTypeSchema = z.enum(['SCAN_MISMATCH', 'SHORT_ALLOCATION', 'INVALID_LOCATION', 'DAMAGED_GOODS', 'COUNT_VARIANCE']);

const LogExceptionInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  exceptionType: ExceptionTypeSchema,
  referenceType: z.string().min(1).optional(),
  referenceId: z.uuid().optional(),
  severity: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  description: z.string().min(1).optional(),
  openedBy: z.uuid().optional(),
});
export type LogExceptionInput = z.input<typeof LogExceptionInputSchema>;

/**
 * Deliberately its own top-level transaction, never sharing the caller's client: every producer
 * of an exception (a rejected scan, a short allocation, a rejected scanned location, a damaged
 * report, a count variance) is a path that *throws* or otherwise leaves the caller's own
 * transaction rolling back or already committed — logging here must survive independently of
 * that outcome, so this always opens (and commits) its own connection. Not run through
 * `@pss/audit`'s mandatory-audit boundary: this is an operational queue entry, not a business
 * mutation of a domain aggregate.
 */
export async function logException(pool: Pool, input: LogExceptionInput): Promise<{ id: string }> {
  const parsed = LogExceptionInputSchema.parse(input);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO wms.exception_queue (
       id, organization_id, warehouse_id, exception_type, reference_type, reference_id, severity, description, opened_by, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')`,
    [id, parsed.organizationId, parsed.warehouseId, parsed.exceptionType, parsed.referenceType ?? null, parsed.referenceId ?? null, parsed.severity, parsed.description ?? null, parsed.openedBy ?? null],
  );
  return { id };
}

const AssignExceptionInputSchema = z.strictObject({ id: z.uuid(), assignedTo: z.uuid() });
export type AssignExceptionInput = z.input<typeof AssignExceptionInputSchema>;

export async function assignException(pool: Pool, input: AssignExceptionInput): Promise<{ id: string }> {
  const parsed = AssignExceptionInputSchema.parse(input);
  const result = await pool.query(
    `UPDATE wms.exception_queue SET assigned_to = $2, status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END WHERE id = $1 RETURNING id`,
    [parsed.id, parsed.assignedTo],
  );
  if (result.rowCount === 0) throw new DomainError('NOT_FOUND');
  return { id: parsed.id };
}

const ResolveExceptionInputSchema = z.strictObject({ id: z.uuid() });
export type ResolveExceptionInput = z.input<typeof ResolveExceptionInputSchema>;

/** Queue-level bookkeeping only ("this ticket is closed") — the underlying correction, if any, already happened via `resolveStockDiscrepancy` or an operator redoing the scan. */
export async function resolveException(pool: Pool, input: ResolveExceptionInput): Promise<{ id: string }> {
  const parsed = ResolveExceptionInputSchema.parse(input);
  const result = await pool.query(
    `UPDATE wms.exception_queue SET status = 'RESOLVED', resolved_at = now() WHERE id = $1 AND status != 'RESOLVED' RETURNING id`,
    [parsed.id],
  );
  if (result.rowCount === 0) throw new DomainError('NOT_FOUND');
  return { id: parsed.id };
}

const GetExceptionQueueInputSchema = z.strictObject({
  warehouseId: z.uuid(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(),
});
export type GetExceptionQueueInput = z.input<typeof GetExceptionQueueInputSchema>;

export interface ExceptionQueueItem {
  id: string;
  exceptionType: string;
  referenceType: string | null;
  referenceId: string | null;
  severity: string;
  status: string;
  description: string | null;
  assignedTo: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export async function getExceptionQueue(pool: Pool, input: GetExceptionQueueInput): Promise<ExceptionQueueItem[]> {
  const parsed = GetExceptionQueueInputSchema.parse(input);
  const result = await pool.query<{
    id: string; exception_type: string; reference_type: string | null; reference_id: string | null;
    severity: string; status: string; description: string | null; assigned_to: string | null;
    opened_at: string; resolved_at: string | null;
  }>(
    parsed.status
      ? `SELECT * FROM wms.exception_queue WHERE warehouse_id = $1 AND status = $2 ORDER BY opened_at DESC`
      : `SELECT * FROM wms.exception_queue WHERE warehouse_id = $1 ORDER BY opened_at DESC`,
    parsed.status ? [parsed.warehouseId, parsed.status] : [parsed.warehouseId],
  );
  return result.rows.map((row) => ({
    id: row.id, exceptionType: row.exception_type, referenceType: row.reference_type, referenceId: row.reference_id,
    severity: row.severity, status: row.status, description: row.description, assignedTo: row.assigned_to,
    openedAt: row.opened_at, resolvedAt: row.resolved_at,
  }));
}
