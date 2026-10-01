import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { parseCommandInput } from '../domain/rules/parse-command-input';
import { ProductStatusSchema } from './create-product';

const UpdateProductInputSchema = z.strictObject({
  organizationId: z.uuid(),
  productId: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  status: ProductStatusSchema.optional(),
  baseUom: z.string().trim().min(1).max(16).optional(),
  orderCapture: z.enum(['PSS', 'EXTERNAL']).optional(),
  /**
   * Optimistic concurrency, supplied by a screen that loaded the product. When it is present and the
   * stored version has moved on, the write is rejected with `STALE_DATA` rather than overwriting a
   * change the operator never saw. An editing screen always passes it.
   */
  expectedVersion: z.number().int().positive().optional(),
  ...OptionalAuditContextSchema.shape,
}).refine(
  (input) => input.name !== undefined || input.status !== undefined || input.baseUom !== undefined || input.orderCapture !== undefined,
  { message: 'Isi minimal satu kolom yang akan diubah.', path: ['name'] },
);

export type UpdateProductInput = z.input<typeof UpdateProductInputSchema>;

export interface UpdatedProduct {
  productId: string;
  version: number;
}

interface ProductRow {
  version: number;
  name: string;
  status: string;
  base_uom: string;
  order_capture: string;
}

/** The editable columns, each paired with its input field, so the audit changes and the UPDATE cannot disagree. */
const EDITS = [
  { column: 'name', field: 'name' },
  { column: 'status', field: 'status' },
  { column: 'base_uom', field: 'baseUom' },
  { column: 'order_capture', field: 'orderCapture' },
] as const;

/**
 * MDM-002: edits a product's own attributes. `sku` is deliberately not editable — it is the identity
 * other systems key on, and the PRD has no rename rule for it (MDM-006 merge is the sanctioned way to
 * replace a product). `version` is bumped so a concurrent screen sees the change.
 *
 * The whole row is read once under `FOR UPDATE`, so the before-values in the audit entry are the
 * values this statement actually overwrote rather than a second read that could race it.
 *
 * A product outside the caller's organization is `NOT_FOUND`, not `PERMISSION_DENIED`: the existence
 * of another organization's product is not this caller's business (AGENTS.md §15).
 */
export async function updateProduct(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: UpdateProductInput,
): Promise<UpdatedProduct> {
  const input = parseCommandInput(UpdateProductInputSchema, rawInput);

  const work = async (transaction: AuditedTransaction): Promise<UpdatedProduct> => {
    const tx = transaction.client;
    const current = await tx.query<ProductRow>(
      `SELECT version, name, status, base_uom, order_capture
       FROM core.product WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.productId, input.organizationId],
    );
    const row = current.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw new DomainError('STALE_DATA', ['Muat Ulang']);
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    const changes: { path: string; classification: 'INTERNAL'; before: string; after: string }[] = [];
    for (const edit of EDITS) {
      const next = input[edit.field];
      if (next === undefined || next === row[edit.column]) continue;
      values.push(next);
      assignments.push(`${edit.column} = $${values.length}`);
      changes.push({ path: edit.field, classification: 'INTERNAL', before: row[edit.column], after: next });
    }

    const auditContext = resolveAuditContext(input, input.productId);
    // An edit that changes nothing still leaves an audit entry (ADR-0013 §4b): the operator asked,
    // and the trail should say the answer was "already like that". `runAuditedWork` rejects a
    // transaction that appended nothing, so the no-change path appends its own.
    if (assignments.length === 0) {
      await transaction.appendAuditEntry({
        organizationId: input.organizationId,
        actor: auditContext.actor,
        action: 'PRODUCT_UPDATED',
        entity: { domain: 'master-data', type: 'Product', id: input.productId, version: row.version },
        changes: [{ path: 'name', classification: 'INTERNAL', before: row.name, after: row.name }],
        requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
      });
      return { productId: input.productId, version: row.version };
    }

    values.push(input.productId);
    const updated = await tx.query<{ version: number }>(
      `UPDATE core.product SET ${assignments.join(', ')}, version = version + 1, updated_at = now()
       WHERE id = $${values.length}
       RETURNING version`,
      values,
    );
    const version = updated.rows[0]!.version;

    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRODUCT_UPDATED',
      entity: { domain: 'master-data', type: 'Product', id: input.productId, version },
      changes,
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });
    return { productId: input.productId, version };
  };

  return withConnection(pool, client, work);
}
