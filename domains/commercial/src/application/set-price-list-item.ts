import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { parseCommandInput } from '../domain/rules/parse-command-input';

/**
 * Matches `core.price_list_item.unit_price`: `numeric(18,2)`, non-negative, and COM-001's exception
 * flow E1 ("Harga ≤ 0 → ditolak"). The same upper bound as `activatePriceList`, so a price written by
 * either path is accepted by the column.
 */
const UnitPriceSchema = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Harga harus angka dengan maksimal 2 desimal.');

const SetPriceListItemInputSchema = z.strictObject({
  organizationId: z.uuid(),
  priceListId: z.uuid(),
  /** A plain reference: `master-data` owns `core.product`, and this domain never reads its tables. */
  productId: z.uuid(),
  uom: z.string().min(1).max(16),
  unitPrice: UnitPriceSchema,
  ...OptionalAuditContextSchema.shape,
});

export type SetPriceListItemInput = z.input<typeof SetPriceListItemInputSchema>;

export interface PriceListItemSet {
  priceListItemId: string;
  priceListId: string;
  productId: string;
  uom: string;
  unitPrice: string;
  version: number;
}

/**
 * COM-001: sets one product's price for one unit on a DRAFT list, creating the item or replacing the
 * previous value on that same draft.
 *
 * COM-001.NC01 — an ACTIVE price must not be editable. A list that has left `DRAFT` is refused with
 * `INVALID_STATE_TRANSITION` and a message that names the way out, because the alternative
 * (COM-001.BR02) is a new version: `createDraftPriceList` with `copyFromPriceListId` set to this list.
 * That is why the check is on the list's status rather than on a permission.
 *
 * Re-setting the same price is a no-op that still leaves an audit entry (ADR-0013 §4b): the operator
 * asked, and the trail records that the answer was "already that value".
 */
export async function setPriceListItem(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: SetPriceListItemInput,
): Promise<PriceListItemSet> {
  const input = parseCommandInput(SetPriceListItemInputSchema, rawInput);

  const work = async (transaction: AuditedTransaction): Promise<PriceListItemSet> => {
    const tx = transaction.client;
    const list = await tx.query<{ status: string; version: number }>(
      'SELECT status, version FROM core.price_list WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.priceListId, input.organizationId],
    );
    const row = list.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status !== 'DRAFT') {
      throw new DomainError('INVALID_STATE_TRANSITION', ['Buat Versi Baru'], [{
        path: 'priceListId', code: 'not_draft',
        message: 'Harga yang sudah aktif tidak bisa diubah. Buat versi daftar harga baru.',
      }]);
    }

    const existing = await tx.query<{ id: string; unit_price: string }>(
      'SELECT id, unit_price FROM core.price_list_item WHERE price_list_id = $1 AND product_id = $2 AND uom = $3',
      [input.priceListId, input.productId, input.uom],
    );
    const previous = existing.rows[0];

    if (previous && previous.unit_price === input.unitPrice) {
      const auditContext = resolveAuditContext(input, input.priceListId);
      await transaction.appendAuditEntry({
        organizationId: input.organizationId,
        actor: auditContext.actor,
        action: 'PRICE_LIST_ITEM_SET',
        entity: { domain: 'commercial', type: 'PriceListItem', id: previous.id, version: row.version },
        changes: [
          { path: 'unitPrice', classification: 'INTERNAL', before: previous.unit_price, after: previous.unit_price },
        ],
        requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
      });
      return {
        priceListItemId: previous.id, priceListId: input.priceListId, productId: input.productId,
        uom: input.uom, unitPrice: previous.unit_price, version: row.version,
      };
    }

    const priceListItemId = previous?.id ?? randomUUID();
    await tx.query(
      `INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price)
       VALUES ($1, $2, $3, $4, $5::numeric)
       ON CONFLICT (price_list_id, product_id, uom)
       DO UPDATE SET unit_price = EXCLUDED.unit_price`,
      [priceListItemId, input.priceListId, input.productId, input.uom, input.unitPrice],
    );

    const auditContext = resolveAuditContext(input, input.priceListId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRICE_LIST_ITEM_SET',
      entity: { domain: 'commercial', type: 'PriceListItem', id: priceListItemId, version: row.version },
      changes: [
        { path: 'unitPrice', classification: 'INTERNAL', before: previous?.unit_price ?? null, after: input.unitPrice },
        { path: 'uom', classification: 'INTERNAL', after: input.uom },
      ],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return {
      priceListItemId, priceListId: input.priceListId, productId: input.productId,
      uom: input.uom, unitPrice: input.unitPrice, version: row.version,
    };
  };

  return withConnection(pool, client, work);
}
