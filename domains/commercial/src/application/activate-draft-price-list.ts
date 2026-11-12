import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { parseCommandInput } from '../domain/rules/parse-command-input';
import { supersedeActiveListForScope, type PriceListAuditInput } from './price-list-activation';

const ActivateDraftPriceListInputSchema = z.strictObject({
  organizationId: z.uuid(),
  priceListId: z.uuid(),
  ...OptionalAuditContextSchema.shape,
});

export type ActivateDraftPriceListInput = z.input<typeof ActivateDraftPriceListInputSchema>;

export interface ActivatedDraft {
  priceListId: string;
  scope: string;
  version: number;
  itemCount: number;
}

/**
 * COM-001.BR02 step 4: publishes the DRAFT that `setPriceListItem` edited, expiring the list it
 * replaces — in one transaction, so no reader outside it ever sees two ACTIVE lists for a scope or
 * none.
 *
 * Activation is not restricted to a caller that proposed the prices. COM-001 requires an approval
 * step and a different approver, and the MVP builds neither (MVP-OD-13); adding the proposer check
 * here without the approval workflow would block the only path that can activate a list, so the
 * missing control is recorded rather than half-built.
 *
 * A DRAFT with no items is refused: an ACTIVE list with no prices would make every sale for that
 * scope fail `PRICE_NOT_FOUND` at the counter, which is worse than refusing to publish it here.
 */
export async function activateDraftPriceList(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ActivateDraftPriceListInput,
): Promise<ActivatedDraft> {
  const input = parseCommandInput(ActivateDraftPriceListInputSchema, rawInput);

  const work = async (transaction: AuditedTransaction): Promise<ActivatedDraft> => {
    const tx = transaction.client;
    const list = await tx.query<{ scope: string; status: string; version: number; valid_from: string }>(
      // `to_char`, not the bare column: pg parses a `date` into a JS Date, and a Date is neither the
      // `BusinessDate` string this domain's contracts use nor a value the audit entry accepts.
      `SELECT scope, status, version, to_char(valid_from, 'YYYY-MM-DD') AS valid_from
       FROM core.price_list WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.priceListId, input.organizationId],
    );
    const row = list.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status !== 'DRAFT') {
      throw new DomainError('INVALID_STATE_TRANSITION', ['Buat Versi Baru'], [{
        path: 'priceListId', code: 'not_draft',
        message: `Daftar harga versi ${row.version} sudah ${row.status === 'ACTIVE' ? 'aktif' : 'di_finalkan'}.`,
      }]);
    }

    const counted = await tx.query<{ total: string }>(
      'SELECT count(*) AS total FROM core.price_list_item WHERE price_list_id = $1', [input.priceListId],
    );
    const itemCount = Number(counted.rows[0]?.total ?? 0);
    if (itemCount === 0) {
      throw new DomainError('VALIDATION_FAILED', [], [{
        path: 'priceListId', code: 'empty',
        message: 'Daftar harga ini belum punya harga barang. Tambahkan minimal satu barang.',
      }]);
    }

    const version = await supersedeActiveListForScope(
      tx, input.organizationId, row.scope, input.priceListId, row.valid_from,
    );
    const auditInput: PriceListAuditInput = { ...input, scope: row.scope, validFrom: row.valid_from };
    const auditContext = resolveAuditContext(auditInput, input.priceListId);
    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'PRICE_LIST_ACTIVATED',
      entity: { domain: 'commercial', type: 'PriceList', id: input.priceListId, version },
      changes: [
        { path: 'scope', classification: 'INTERNAL', after: row.scope },
        { path: 'validFrom', classification: 'INTERNAL', after: row.valid_from },
        { path: 'status', classification: 'INTERNAL', after: 'ACTIVE' },
        { path: 'itemCount', classification: 'INTERNAL', after: String(itemCount) },
      ],
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { priceListId: input.priceListId, scope: row.scope, version, itemCount };
  };

  return withConnection(pool, client, work);
}
