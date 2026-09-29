import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from './support/with-connection';

const CompletePackingInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  ...OptionalAuditContextSchema.shape,
});
export type CompletePackingInput = z.input<typeof CompletePackingInputSchema>;

/**
 * WMS-007 "Selesai Pack": `createWarehouseUnit`/`addWarehouseUnitLine` already cover "Buat Koli"
 * and "scan barang ke koli" (WMS-012's generic unit commands, reused here — WMS-007.BR02's "one
 * koli, one DO" falls out of `createWarehouseUnit` requiring a single `referenceId` per unit).
 * This closes packing for one reference: WMS-007.BR01 requires Σ koli contents == Σ picked qty
 * for that reference — a mismatch throws `PACK_QTY_MISMATCH` rather than silently allowing an
 * incomplete pack. Marks every `ACTIVE` unit for the reference `CLOSED` and records one
 * `COMPLETED` `PACK` task.
 */
export async function completePacking(pool: Pool, client: PoolClient | undefined, input: CompletePackingInput): Promise<{ taskId: string; packageCount: number }> {
  const parsed = CompletePackingInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ taskId: string; packageCount: number }> => {
    const tx = transaction.client;

    const picked = await tx.query<{ total: string | null }>(
      `SELECT SUM(qty_confirmed)::text AS total FROM wms.warehouse_task
       WHERE type = 'PICK' AND reference_type = $1 AND reference_id = $2 AND status IN ('COMPLETED', 'COMPLETED_SHORT')`,
      [parsed.referenceType, parsed.referenceId],
    );
    const pickedTotal = picked.rows[0]?.total ?? '0';

    const packed = await tx.query<{ total: string | null; package_count: string }>(
      `SELECT SUM(l.qty)::text AS total, count(DISTINCT u.id)::text AS package_count
       FROM wms.warehouse_unit u JOIN wms.warehouse_unit_line l ON l.unit_id = u.id
       WHERE u.reference_type = $1 AND u.reference_id = $2 AND u.status = 'ACTIVE'`,
      [parsed.referenceType, parsed.referenceId],
    );
    const packedTotal = packed.rows[0]?.total ?? '0';
    const packageCount = Number(packed.rows[0]?.package_count ?? '0');

    if (packageCount === 0 || Number(packedTotal) !== Number(pickedTotal)) throw new DomainError('PACK_QTY_MISMATCH');

    await tx.query(
      `UPDATE wms.warehouse_unit SET status = 'CLOSED' WHERE reference_type = $1 AND reference_id = $2 AND status = 'ACTIVE'`,
      [parsed.referenceType, parsed.referenceId],
    );

    const taskId = randomUUID();
    await tx.query(
      `INSERT INTO wms.warehouse_task (
         id, organization_id, warehouse_id, type, status, reference_type, reference_id, qty_expected, qty_confirmed
       ) VALUES ($1, $2, $3, 'PACK', 'COMPLETED', $4, $5, $6, $7)`,
      [taskId, parsed.organizationId, parsed.warehouseId, parsed.referenceType, parsed.referenceId, pickedTotal, packedTotal],
    );

    const auditContext = resolveAuditContext(parsed, parsed.referenceId);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'PACK_COMPLETED',
      entity: { domain: 'wms', type: 'WarehouseTask', id: taskId, version: 1 },
      changes: [{ path: 'packageCount', classification: 'INTERNAL' as const, after: String(packageCount) }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { taskId, packageCount };
  };

  return withConnection(pool, client, work);
}

const StagePackageInputSchema = z.strictObject({
  unitCode: z.string().min(1),
  laneCode: z.string().min(1),
  ...OptionalAuditContextSchema.shape,
});
export type StagePackageInput = z.input<typeof StagePackageInputSchema>;

/**
 * WMS-008: scans one koli into a staging lane (a `STAGING`-type `wms.warehouse_location`,
 * scanned by its code — same code-not-id convention as every other WMS scan). When every koli
 * for the unit's reference has been staged, also records a `COMPLETED` `STAGE` task (the caller —
 * `fulfillment` — reacts to that by moving the FR to READY; not done here, per WMS-008.NC02: "WMS
 * tidak boleh mengubah FR langsung").
 */
export async function stagePackage(pool: Pool, client: PoolClient | undefined, input: StagePackageInput): Promise<{ stageCompleted: boolean; taskId?: string }> {
  const parsed = StagePackageInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ stageCompleted: boolean; taskId?: string }> => {
    const tx = transaction.client;

    const unit = await tx.query<{ id: string; organization_id: string; warehouse_id: string; status: string; reference_type: string | null; reference_id: string | null }>(
      `SELECT id, organization_id, warehouse_id, status, reference_type, reference_id FROM wms.warehouse_unit WHERE code = $1`, [parsed.unitCode],
    );
    const unitRow = unit.rows[0];
    if (!unitRow) throw new DomainError('NOT_FOUND');
    if (unitRow.status !== 'CLOSED') throw new DomainError('INVALID_STATE_TRANSITION');

    const lane = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM wms.warehouse_location WHERE warehouse_id = $1 AND code = $2 AND type = 'STAGING'`,
      [unitRow.warehouse_id, parsed.laneCode],
    );
    const laneRow = lane.rows[0];
    if (!laneRow) throw new DomainError('NOT_FOUND');
    if (laneRow.status !== 'ACTIVE') throw new DomainError('LOCATION_UNAVAILABLE');

    await tx.query(`UPDATE wms.warehouse_unit SET staged_location_id = $2 WHERE id = $1`, [unitRow.id, laneRow.id]);

    const auditContext = resolveAuditContext(parsed, unitRow.id);
    await transaction.appendAuditEntry({
      organizationId: unitRow.organization_id,
      actor: auditContext.actor,
      action: 'PACKAGE_STAGED',
      entity: { domain: 'wms', type: 'WarehouseUnit', id: unitRow.id, version: 2 },
      changes: [{ path: 'stagedLocationId', classification: 'INTERNAL' as const, after: laneRow.id }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    if (!unitRow.reference_type || !unitRow.reference_id) return { stageCompleted: false };

    const pending = await tx.query<{ pending: string }>(
      `SELECT count(*) FILTER (WHERE staged_location_id IS NULL)::text AS pending
       FROM wms.warehouse_unit WHERE reference_type = $1 AND reference_id = $2 AND status != 'CANCELLED'`,
      [unitRow.reference_type, unitRow.reference_id],
    );
    if (Number(pending.rows[0]!.pending) > 0) return { stageCompleted: false };

    const taskId = randomUUID();
    await tx.query(
      `INSERT INTO wms.warehouse_task (id, organization_id, warehouse_id, type, status, reference_type, reference_id)
       VALUES ($1, $2, $3, 'STAGE', 'COMPLETED', $4, $5)`,
      [taskId, unitRow.organization_id, unitRow.warehouse_id, unitRow.reference_type, unitRow.reference_id],
    );
    await transaction.appendAuditEntry({
      organizationId: unitRow.organization_id,
      actor: auditContext.actor,
      action: 'STAGE_COMPLETED',
      entity: { domain: 'wms', type: 'WarehouseTask', id: taskId, version: 1 },
      changes: [{ path: 'referenceId', classification: 'INTERNAL' as const, after: unitRow.reference_id }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { stageCompleted: true, taskId };
  };

  return withConnection(pool, client, work);
}

const LoadPackageInputSchema = z.strictObject({
  unitCode: z.string().min(1),
  vehicleCode: z.string().min(1),
  ...OptionalAuditContextSchema.shape,
});
export type LoadPackageInput = z.input<typeof LoadPackageInputSchema>;

/**
 * WMS-009: scans one koli onto a vehicle (a free-text `vehicleCode`, e.g. a license plate — no
 * `fleet` domain exists to look up a real vehicle record against, so this is recorded as-given).
 * A koli must be staged first (WMS-004/008 order). When every koli currently staged in the same
 * lane as this one has been loaded, also records a `COMPLETED` `LOAD` task scoped to that lane —
 * the lane stands in for "this shipment" (see DOMAIN.md open decisions: no shipment aggregate
 * exists yet, so a staging lane is the grouping WMS itself can observe).
 */
export async function loadPackage(pool: Pool, client: PoolClient | undefined, input: LoadPackageInput): Promise<{ loadCompleted: boolean; taskId?: string }> {
  const parsed = LoadPackageInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ loadCompleted: boolean; taskId?: string }> => {
    const tx = transaction.client;

    const unit = await tx.query<{ id: string; organization_id: string; warehouse_id: string; staged_location_id: string | null; loaded_at: string | null }>(
      `SELECT id, organization_id, warehouse_id, staged_location_id, loaded_at FROM wms.warehouse_unit WHERE code = $1`, [parsed.unitCode],
    );
    const unitRow = unit.rows[0];
    if (!unitRow) throw new DomainError('NOT_FOUND');
    if (!unitRow.staged_location_id) throw new DomainError('INVALID_STATE_TRANSITION');
    if (unitRow.loaded_at) throw new DomainError('INVALID_STATE_TRANSITION');

    await tx.query(`UPDATE wms.warehouse_unit SET loaded_vehicle_code = $2, loaded_at = now() WHERE id = $1`, [unitRow.id, parsed.vehicleCode]);

    const auditContext = resolveAuditContext(parsed, unitRow.id);
    await transaction.appendAuditEntry({
      organizationId: unitRow.organization_id,
      actor: auditContext.actor,
      action: 'PACKAGE_LOADED',
      entity: { domain: 'wms', type: 'WarehouseUnit', id: unitRow.id, version: 3 },
      changes: [{ path: 'loadedVehicleCode', classification: 'INTERNAL' as const, after: parsed.vehicleCode }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    const pending = await tx.query<{ pending: string }>(
      `SELECT count(*) FILTER (WHERE loaded_at IS NULL)::text AS pending
       FROM wms.warehouse_unit WHERE staged_location_id = $1 AND status != 'CANCELLED'`,
      [unitRow.staged_location_id],
    );
    if (Number(pending.rows[0]!.pending) > 0) return { loadCompleted: false };

    const taskId = randomUUID();
    await tx.query(
      `INSERT INTO wms.warehouse_task (id, organization_id, warehouse_id, type, status, location_id)
       VALUES ($1, $2, $3, 'LOAD', 'COMPLETED', $4)`,
      [taskId, unitRow.organization_id, unitRow.warehouse_id, unitRow.staged_location_id],
    );
    await transaction.appendAuditEntry({
      organizationId: unitRow.organization_id,
      actor: auditContext.actor,
      action: 'LOAD_COMPLETED',
      entity: { domain: 'wms', type: 'WarehouseTask', id: taskId, version: 1 },
      changes: [{ path: 'vehicleCode', classification: 'INTERNAL' as const, after: parsed.vehicleCode }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { loadCompleted: true, taskId };
  };

  return withConnection(pool, client, work);
}
