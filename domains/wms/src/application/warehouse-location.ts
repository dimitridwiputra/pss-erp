import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from '@pss/platform';

const LocationTypeSchema = z.enum(['ZONE', 'AISLE', 'RACK', 'BIN', 'RECEIVING', 'STAGING', 'QUARANTINE']);

const RegisterWarehouseLocationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  code: z.string().min(1),
  parentLocationId: z.uuid().optional(),
  type: LocationTypeSchema,
  capacityQty: DecimalStringSchema.optional(),
  ...OptionalAuditContextSchema.shape,
});
export type RegisterWarehouseLocationInput = z.input<typeof RegisterWarehouseLocationInputSchema>;

/**
 * WMS-001: registers one location in the zone -> aisle -> rack -> bin hierarchy (or a functional
 * RECEIVING/STAGING/QUARANTINE location). WMS-001.BR01: code unique per warehouse (enforced by a
 * table UNIQUE, caught here as a friendly error). A parent, when given, must already exist in the
 * same warehouse.
 */
export async function registerWarehouseLocation(pool: Pool, client: PoolClient | undefined, input: RegisterWarehouseLocationInput): Promise<{ id: string }> {
  const parsed = RegisterWarehouseLocationInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ id: string }> => {
    const tx = transaction.client;

    if (parsed.parentLocationId) {
      const parent = await tx.query(`SELECT id FROM wms.warehouse_location WHERE id = $1 AND warehouse_id = $2`, [parsed.parentLocationId, parsed.warehouseId]);
      if (parent.rowCount === 0) throw new DomainError('NOT_FOUND');
    }

    const id = randomUUID();
    try {
      await tx.query(
        `INSERT INTO wms.warehouse_location (id, organization_id, warehouse_id, code, parent_location_id, type, status, capacity_qty)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)`,
        [id, parsed.organizationId, parsed.warehouseId, parsed.code, parsed.parentLocationId ?? null, parsed.type, parsed.capacityQty ?? null],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new DomainError('VALIDATION_FAILED', [], [{ path: 'code', code: 'duplicate', message: 'Kode lokasi sudah dipakai di gudang ini.' }]);
      }
      throw error;
    }

    const auditContext = resolveAuditContext(parsed, id);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'WAREHOUSE_LOCATION_REGISTERED',
      entity: { domain: 'wms', type: 'WarehouseLocation', id, version: 1 },
      changes: [{ path: 'code', classification: 'INTERNAL' as const, after: parsed.code }, { path: 'type', classification: 'INTERNAL' as const, after: parsed.type }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { id };
  };

  return withConnection(pool, client, work);
}

const SetWarehouseLocationStatusInputSchema = z.strictObject({
  locationId: z.uuid(),
  status: z.enum(['ACTIVE', 'BLOCKED']),
  ...OptionalAuditContextSchema.shape,
});
export type SetWarehouseLocationStatusInput = z.input<typeof SetWarehouseLocationStatusInputSchema>;

/**
 * WMS-001.BR02: a location holding stock cannot be blocked/removed from service — `LOCATION_NOT_EMPTY`
 * guards that. (Deleting a location outright is not exposed at all in this P0 slice; only its
 * status can change.)
 */
export async function setWarehouseLocationStatus(pool: Pool, client: PoolClient | undefined, input: SetWarehouseLocationStatusInput): Promise<{ id: string; status: string }> {
  const parsed = SetWarehouseLocationStatusInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ id: string; status: string }> => {
    const tx = transaction.client;

    const location = await tx.query<{ organization_id: string; status: string }>(
      `SELECT organization_id, status FROM wms.warehouse_location WHERE id = $1 FOR UPDATE`, [parsed.locationId],
    );
    const locationRow = location.rows[0];
    if (!locationRow) throw new DomainError('NOT_FOUND');

    if (parsed.status === 'BLOCKED') {
      const stock = await tx.query(`SELECT 1 FROM wms.physical_stock WHERE location_id = $1 AND qty_on_hand > 0 LIMIT 1`, [parsed.locationId]);
      if ((stock.rowCount ?? 0) > 0) throw new DomainError('LOCATION_NOT_EMPTY');
    }

    await tx.query(`UPDATE wms.warehouse_location SET status = $2, updated_at = now() WHERE id = $1`, [parsed.locationId, parsed.status]);

    const auditContext = resolveAuditContext(parsed, parsed.locationId);
    await transaction.appendAuditEntry({
      organizationId: locationRow.organization_id,
      actor: auditContext.actor,
      action: 'WAREHOUSE_LOCATION_STATUS_CHANGED',
      entity: { domain: 'wms', type: 'WarehouseLocation', id: parsed.locationId, version: 2 },
      changes: [{ path: 'status', classification: 'INTERNAL' as const, before: locationRow.status, after: parsed.status }],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { id: parsed.locationId, status: parsed.status };
  };

  return withConnection(pool, client, work);
}

const GetLocationUtilizationInputSchema = z.strictObject({ warehouseId: z.uuid() });
export type GetLocationUtilizationInput = z.input<typeof GetLocationUtilizationInputSchema>;

export interface LocationUtilization {
  locationId: string;
  code: string;
  type: string;
  status: string;
  qtyOnHand: string;
  capacityQty: string | null;
  utilizationPct: number | null;
}

/**
 * Read-only. `utilizationPct` is `null` for a location with no `capacityQty` recorded — reported
 * as "not tracked", never guessed as 0% or 100% (capacity is opt-in per location).
 */
export async function getLocationUtilization(pool: Pool, input: GetLocationUtilizationInput): Promise<LocationUtilization[]> {
  const parsed = GetLocationUtilizationInputSchema.parse(input);
  const result = await pool.query<{ id: string; code: string; type: string; status: string; qty_on_hand: string | null; capacity_qty: string | null }>(
    `SELECT wl.id, wl.code, wl.type, wl.status, COALESCE(SUM(ps.qty_on_hand), 0::numeric(18,3))::text AS qty_on_hand, wl.capacity_qty
     FROM wms.warehouse_location wl LEFT JOIN wms.physical_stock ps ON ps.location_id = wl.id
     WHERE wl.warehouse_id = $1
     GROUP BY wl.id, wl.code, wl.type, wl.status, wl.capacity_qty
     ORDER BY wl.code ASC`,
    [parsed.warehouseId],
  );
  return result.rows.map((row) => ({
    locationId: row.id, code: row.code, type: row.type, status: row.status,
    qtyOnHand: row.qty_on_hand ?? '0.000', capacityQty: row.capacity_qty,
    utilizationPct: row.capacity_qty ? Number(row.qty_on_hand) / Number(row.capacity_qty) : null,
  }));
}
