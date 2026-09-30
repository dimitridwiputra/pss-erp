import type { PoolClient } from 'pg';
import { DomainError } from '@pss/contracts';

/**
 * Refuses a warehouse that already holds stock for a different organization.
 *
 * The MVP has no warehouse registry a back-office command can ask: `wms.warehouse_config` is the one,
 * and `domains/wms` is frozen for this release, so there is no "warehouse by id → its organization"
 * read to resolve a supplied id against. What `inventory` *can* know is every organization that has
 * ever held stock in a warehouse, because that fact is in its own `stock_balance`.
 *
 * So this is the narrow part of the check, not the whole of it: a warehouse another organization has
 * used is refused as `NOT_FOUND` — the same answer as an id that does not exist, because the
 * existence of another organization's warehouse is not this caller's business (AGENTS.md §15). A
 * warehouse id that nobody has ever stocked is still accepted, because nothing in this build can say
 * it does not exist, and the caller's warehouse scope is the only gate on it. MVP-OD-22 records the
 * structural gap and who has to close it.
 *
 * It runs on the write paths only. A read is already filtered by `organization_id`, so a foreign
 * warehouse returns an empty page rather than data, and paying for this query on every list is not
 * worth it.
 */
export async function assertWarehouseNotForeign(
  tx: PoolClient,
  organizationId: string,
  warehouseId: string,
): Promise<void> {
  const foreign = await tx.query<{ organization_id: string }>(
    `SELECT DISTINCT organization_id FROM inventory.stock_balance
     WHERE warehouse_id = $1 AND organization_id <> $2
     LIMIT 1`,
    [warehouseId, organizationId],
  );
  if (foreign.rows[0]) throw new DomainError('NOT_FOUND');
}
