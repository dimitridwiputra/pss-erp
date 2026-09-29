import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from './support/with-connection';

const CreateWarehouseUnitLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), qty: DecimalStringSchema });

const CreateWarehouseUnitInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  unitType: z.enum(['PALLET', 'CARTON', 'PACKAGE']),
  referenceType: z.string().min(1).optional(),
  referenceId: z.uuid().optional(),
  lines: z.array(CreateWarehouseUnitLineSchema).default([]),
  ...OptionalAuditContextSchema.shape,
});
export type CreateWarehouseUnitInput = z.input<typeof CreateWarehouseUnitInputSchema>;

/**
 * WMS-012 (simplified): registers one physical unit (pallet/carton/koli) with a unique code —
 * the payload a printed QR label would encode is just `{type, id}` per WMS-012.BR01, so the code
 * itself carries no business data. Lines are optional at creation (WMS-007's "scan barang ke
 * koli" appends them one at a time via `addWarehouseUnitLine`, not here).
 */
export async function createWarehouseUnit(pool: Pool, client: PoolClient | undefined, input: CreateWarehouseUnitInput): Promise<{ id: string; code: string }> {
  const parsed = CreateWarehouseUnitInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ id: string; code: string }> => {
    const tx = transaction.client;
    const id = randomUUID();
    const code = `${parsed.unitType.slice(0, 3)}-${id.slice(0, 8).toUpperCase()}`;

    await tx.query(
      `INSERT INTO wms.warehouse_unit (id, organization_id, warehouse_id, unit_type, code, reference_type, reference_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
      [id, parsed.organizationId, parsed.warehouseId, parsed.unitType, code, parsed.referenceType ?? null, parsed.referenceId ?? null],
    );
    for (const line of parsed.lines) {
      await tx.query(
        `INSERT INTO wms.warehouse_unit_line (id, unit_id, product_id, uom, qty) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), id, line.productId, line.uom, line.qty],
      );
    }

    const auditContext = resolveAuditContext(parsed, id);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'WAREHOUSE_UNIT_CREATED',
      entity: { domain: 'wms', type: 'WarehouseUnit', id, version: 1 },
      changes: [{ path: 'unitType', classification: 'INTERNAL' as const, after: parsed.unitType }, { path: 'code', classification: 'INTERNAL' as const, after: code }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { id, code };
  };

  return withConnection(pool, client, work);
}

const AddWarehouseUnitLineInputSchema = z.strictObject({
  unitCode: z.string().min(1),
  productId: z.uuid(),
  uom: z.string().min(1),
  qty: DecimalStringSchema,
  ...OptionalAuditContextSchema.shape,
});
export type AddWarehouseUnitLineInput = z.input<typeof AddWarehouseUnitLineInputSchema>;

/** WMS-007: "scan barang ke koli" — appends one scanned line to an ACTIVE unit, identified by its scanned code. */
export async function addWarehouseUnitLine(pool: Pool, client: PoolClient | undefined, input: AddWarehouseUnitLineInput): Promise<{ lineId: string }> {
  const parsed = AddWarehouseUnitLineInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ lineId: string }> => {
    const tx = transaction.client;
    const unit = await tx.query<{ id: string; organization_id: string; status: string }>(
      `SELECT id, organization_id, status FROM wms.warehouse_unit WHERE code = $1`, [parsed.unitCode],
    );
    const unitRow = unit.rows[0];
    if (!unitRow) throw new DomainError('NOT_FOUND');
    if (unitRow.status !== 'ACTIVE') throw new DomainError('INVALID_STATE_TRANSITION');

    const lineId = randomUUID();
    await tx.query(
      `INSERT INTO wms.warehouse_unit_line (id, unit_id, product_id, uom, qty) VALUES ($1, $2, $3, $4, $5)`,
      [lineId, unitRow.id, parsed.productId, parsed.uom, parsed.qty],
    );

    const auditContext = resolveAuditContext(parsed, unitRow.id);
    await transaction.appendAuditEntry({
      organizationId: unitRow.organization_id,
      actor: auditContext.actor,
      action: 'WAREHOUSE_UNIT_LINE_ADDED',
      entity: { domain: 'wms', type: 'WarehouseUnit', id: unitRow.id, version: 2 },
      changes: [{ path: 'lines[]', classification: 'INTERNAL' as const, after: `${parsed.qty} ${parsed.uom}` }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { lineId };
  };

  return withConnection(pool, client, work);
}

const PrintLabelInputSchema = z.strictObject({
  subjectType: z.enum(['LOCATION', 'UNIT']),
  subjectId: z.uuid(),
  ...OptionalAuditContextSchema.shape,
});
export type PrintLabelInput = z.input<typeof PrintLabelInputSchema>;

/**
 * WMS-012.R02: every print (first or reprint) is audited. Returns `copyNumber` so the caller can
 * render "SALINAN" (copy) on anything after the first, per DOC-002's reprint mark convention.
 */
export async function printLabel(pool: Pool, client: PoolClient | undefined, input: PrintLabelInput): Promise<{ copyNumber: number }> {
  const parsed = PrintLabelInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ copyNumber: number }> => {
    const tx = transaction.client;

    // `table` is one of two hardcoded literals selected by the enum check above, never
    // user-supplied text, so this interpolation cannot be used for SQL injection.
    const table = parsed.subjectType === 'LOCATION' ? 'wms.warehouse_location' : 'wms.warehouse_unit';
    const subject = await tx.query<{ organization_id: string }>(`SELECT organization_id FROM ${table} WHERE id = $1`, [parsed.subjectId]);
    const subjectRow = subject.rows[0];
    if (!subjectRow) throw new DomainError('NOT_FOUND');

    const priorCount = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wms.label_print WHERE subject_type = $1 AND subject_id = $2`,
      [parsed.subjectType, parsed.subjectId],
    );
    const copyNumber = Number(priorCount.rows[0]!.count) + 1;

    await tx.query(
      `INSERT INTO wms.label_print (id, organization_id, subject_type, subject_id, copy_number, printed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), subjectRow.organization_id, parsed.subjectType, parsed.subjectId, copyNumber, parsed.actor?.userId ?? null],
    );

    const auditContext = resolveAuditContext(parsed, parsed.subjectId);
    await transaction.appendAuditEntry({
      organizationId: subjectRow.organization_id,
      actor: auditContext.actor,
      action: copyNumber > 1 ? 'LABEL_REPRINTED' : 'LABEL_PRINTED',
      entity: { domain: 'wms', type: parsed.subjectType === 'LOCATION' ? 'WarehouseLocation' : 'WarehouseUnit', id: parsed.subjectId, version: copyNumber },
      changes: [{ path: 'copyNumber', classification: 'INTERNAL' as const, after: String(copyNumber) }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { copyNumber };
  };

  return withConnection(pool, client, work);
}
