import type { PoolClient } from 'pg';
import { DomainError } from '@pss/contracts';
import type { OptionalAuditContext } from './support/audit-context';

/** What the audit entry for an activation needs beyond the caller's own audit context. */
export type PriceListAuditInput = OptionalAuditContext & { scope: string; validFrom: string };

/**
 * Expires the list currently ACTIVE for this scope, then makes `priceListId` the one ACTIVE list.
 *
 * Shared by the two activation paths (`activatePriceList`, which builds a list and publishes it, and
 * `activateDraftPriceList`, which publishes a draft an operator edited) so "at most one ACTIVE per
 * scope" is one piece of SQL rather than two that can drift. The partial unique index
 * `price_list_active_scope_idx` is what actually enforces the rule, so the expire must precede the
 * activate and both must share one transaction, or the index rejects the second write.
 *
 * The `id <> $3` guard matters for the create-and-activate path: it re-activates a row it just
 * inserted, and without the guard the expire would expire that same row and the activate would find
 * nothing to update.
 */
export async function supersedeActiveListForScope(
  tx: PoolClient,
  organizationId: string,
  scope: string,
  priceListId: string,
  validFrom: string,
): Promise<number> {
  await tx.query(
    `UPDATE core.price_list SET status = 'EXPIRED', updated_at = now()
     WHERE organization_id = $1 AND scope = $2 AND status = 'ACTIVE' AND id <> $3`,
    [organizationId, scope, priceListId],
  );
  const activated = await tx.query<{ version: number }>(
    `UPDATE core.price_list SET status = 'ACTIVE', valid_from = $4, updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND scope = $3
     RETURNING version`,
    [priceListId, organizationId, scope, validFrom],
  );
  const version = activated.rows[0]?.version;
  if (version === undefined) throw new DomainError('NOT_FOUND');
  return version;
}
