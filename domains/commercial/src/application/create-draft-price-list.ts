import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { BusinessDateSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const CreateDraftPriceListInputSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Opaque to this domain: OD-190 (how POS's price-list scope should work) is still open. */
  scope: z.string().min(1).max(64),
  validFrom: BusinessDateSchema,
  /**
   * The list whose items this draft starts from. Copying is how COM-001.BR02's "a change is a new
   * version" is actually usable: an operator edits the copy of the live list rather than retyping it,
   * and the version number the orders will see is already decided here.
   */
  copyFromPriceListId: z.uuid().optional(),
  ...OptionalAuditContextSchema.shape,
});

export type CreateDraftPriceListInput = z.input<typeof CreateDraftPriceListInputSchema>;

export interface DraftPriceList {
  priceListId: string;
  scope: string;
  version: number;
  validFrom: string;
  itemCount: number;
}

/**
 * COM-001.BR02: a price change is a new version, never an edit in place.
 *
 * `activatePriceList` writes a whole ACTIVE list in one call, which is the right shape for a seed and
 * for the demo's first list but the wrong one for "change three prices": it would require the caller
 * to send every item back, and any item it forgot would silently lose its price. This command creates
 * the DRAFT the rest of the flow edits — `setPriceListItem` writes into it and `activateDraftPriceList`
 * publishes it — and optionally copies the items of the list it supersedes so the version starts
 * complete.
 *
 * `version` is one above the highest this scope has ever used, not one above the active list, so the
 * numbers stay monotonic for the offline `priceVersion` cache COM-001.R01 requires. It is read with
 * `max()`, so two concurrent drafts can take the same number; that is acceptable because the partial
 * unique index only constrains `ACTIVE`, and the version only becomes an order's price reference when
 * the list is activated.
 */
export async function createDraftPriceList(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: CreateDraftPriceListInput,
): Promise<DraftPriceList> {
  const input = parseCommandInput(CreateDraftPriceListInputSchema, rawInput);

  const work = async (transaction: AuditedTransaction): Promise<DraftPriceList> => {
    const tx = transaction.client;
    const priceListId = randomUUID();
    const inserted = await tx.query<{ version: number }>(
      `INSERT INTO core.price_list (id, organization_id, scope, status, valid_from, version)
       VALUES ($1, $2, $3, 'DRAFT', $4,
               COALESCE((SELECT max(version) FROM core.price_list WHERE organization_id = $2 AND scope = $3), 0) + 1)
       RETURNING version`,
      [priceListId, input.organizationId, input.scope, input.validFrom],
    );
    const version = inserted.rows[0]!.version;

    let itemCount = 0;
    if (input.copyFromPriceListId !== undefined) {
      const source = await tx.query<{ id: string }>(
        'SELECT id FROM core.price_list WHERE id = $1 AND organization_id = $2',
        [input.copyFromPriceListId, input.organizationId],
      );
      if (!source.rows[0]) throw new DomainError('NOT_FOUND');
      // `gen_random_uuid()` per row, not one id passed in: a single parameter would give every copied
      // row the same primary key.
      const copied = await tx.query(
        `INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price)
         SELECT gen_random_uuid(), $1, product_id, uom, unit_price
         FROM core.price_list_item WHERE price_list_id = $2`,
        [priceListId, input.copyFromPriceListId],
      );
      itemCount = copied.rowCount ?? 0;
    }

    const auditContext = resolveAuditContext(input, priceListId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRICE_LIST_DRAFTED',
      entity: { domain: 'commercial', type: 'PriceList', id: priceListId, version },
      changes: [
        { path: 'scope', classification: 'INTERNAL', after: input.scope },
        { path: 'validFrom', classification: 'INTERNAL', after: input.validFrom },
        { path: 'status', classification: 'INTERNAL', after: 'DRAFT' },
        { path: 'copiedItems', classification: 'INTERNAL', after: String(itemCount) },
      ],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { priceListId, scope: input.scope, version, validFrom: input.validFrom, itemCount };
  };

  return withConnection(pool, client, work);
}
