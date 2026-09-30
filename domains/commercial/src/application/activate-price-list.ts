import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { BusinessDateSchema } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { parseCommandInput } from '../domain/rules/parse-command-input';
import { supersedeActiveListForScope, type PriceListAuditInput } from './price-list-activation';

/**
 * Matches `core.price_list_item.unit_price`: `numeric(18,2)`, non-negative, and COM-001's exception
 * flow E1 ("Harga ≤ 0 → ditolak"). The same bound as `setPriceListItem`, so a price written by either
 * path is accepted by the column.
 */
const UnitPriceSchema = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Harga harus angka dengan maksimal 2 desimal.');

const ActivatePriceListInputSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Opaque to this domain: OD-190 (how POS's price-list scope should work) is still open. */
  scope: z.string().min(1).max(64),
  validFrom: BusinessDateSchema,
  items: z.array(z.strictObject({
    productId: z.uuid(), uom: z.string().min(1).max(16), unitPrice: UnitPriceSchema,
  })).min(1),
  ...OptionalAuditContextSchema.shape,
});

export type ActivatePriceListInput = z.input<typeof ActivatePriceListInputSchema>;

export interface ActivatedPriceList {
  priceListId: string;
  scope: string;
  version: number;
  itemCount: number;
}

/**
 * Creates a new ACTIVE price list with its items and supersedes the one currently ACTIVE for the same
 * `(organizationId, scope)`, in one audited transaction.
 *
 * Two things this deliberately does not do, both recorded as open decisions rather than quietly
 * assumed:
 *
 *   - **No approval step.** COM-001's main flow is "mengajukan → approval `price_list_activation`",
 *     its RBAC line requires a level per `approval.price_list_activation.levels`, and COM-001.AC03
 *     rejects proposer = approver. The MVP activates directly and builds no approval workflow
 *     (MVP-OD-14). This is the largest gap between this command and the PRD.
 *   - **No `PRICE_LIST_ACTIVATED` event.** The name is in the catalog but no payload schema is
 *     registered for it in `packages/contracts/src/events/index.ts`, which this stream does not edit.
 *     Publication stays deferred until one is, and the audit entry §14 requires is what exists now.
 *
 * This is still the right shape for a first list and for a seed. It cannot edit a live list: the
 * caller would have to resend every item, and any item it forgot would silently lose its price. For a
 * price change use `createDraftPriceList` + `setPriceListItem` + `activateDraftPriceList`
 * (COM-001.BR02, "perubahan = versi baru").
 */
export async function activatePriceList(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ActivatePriceListInput,
): Promise<ActivatedPriceList> {
  const input = parseCommandInput(ActivatePriceListInputSchema, rawInput);

  const work = async (transaction: AuditedTransaction): Promise<ActivatedPriceList> => {
    const tx = transaction.client;
    const priceListId = randomUUID();
    // Inserted as DRAFT and flipped by `supersedeActiveListForScope` in the same transaction. The
    // intermediate state is never visible outside it, and it lets `version` be `max(version) + 1` for
    // the scope — which a partial unique index on ACTIVE rows cannot compute for an ACTIVE insert.
    await tx.query(
      `INSERT INTO core.price_list (id, organization_id, scope, status, valid_from, version)
       VALUES ($1, $2, $3, 'DRAFT', $4,
               COALESCE((SELECT max(version) FROM core.price_list WHERE organization_id = $2 AND scope = $3), 0) + 1)`,
      [priceListId, input.organizationId, input.scope, input.validFrom],
    );
    for (const item of input.items) {
      await tx.query(
        `INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price)
         VALUES ($1, $2, $3, $4, $5::numeric)`,
        [randomUUID(), priceListId, item.productId, item.uom, item.unitPrice],
      );
    }

    const version = await supersedeActiveListForScope(
      tx, input.organizationId, input.scope, priceListId, input.validFrom,
    );

    const auditInput: PriceListAuditInput = { ...input, scope: input.scope, validFrom: input.validFrom };
    const auditContext = resolveAuditContext(auditInput, priceListId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRICE_LIST_ACTIVATED',
      entity: { domain: 'commercial', type: 'PriceList', id: priceListId, version },
      changes: [
        { path: 'scope', classification: 'INTERNAL', after: input.scope },
        { path: 'validFrom', classification: 'INTERNAL', after: input.validFrom },
        { path: 'status', classification: 'INTERNAL', after: 'ACTIVE' },
        { path: 'itemCount', classification: 'INTERNAL', after: String(input.items.length) },
      ],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { priceListId, scope: input.scope, version, itemCount: input.items.length };
  };

  return withConnection(pool, client, work);
}
