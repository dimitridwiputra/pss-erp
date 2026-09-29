import { randomUUID } from 'node:crypto';
import { BusinessDateSchema, DomainError } from '@pss/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const PriceListItemInputSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  // Matches core.price_list_item.unit_price: numeric(18,2), non-negative.
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
});

const ActivatePriceListInputSchema = z.strictObject({
  organizationId: z.uuid(),
  scope: z.string().min(1),
  validFrom: BusinessDateSchema,
  items: z.array(PriceListItemInputSchema),
});

export type ActivatePriceListInput = z.input<typeof ActivatePriceListInputSchema>;

export interface ActivatedPriceList {
  priceListId: string;
  version: number;
}

/**
 * Creates a new ACTIVE price list with its items and supersedes any price list
 * currently ACTIVE for the same organization/scope, in one transaction.
 *
 * Event publication for PRICE_LIST_ACTIVATED is deferred: no payload schema is
 * registered for it yet. OD-190 (price list scope for POS, docs/PRODUCT_PRD.md
 * Appendix J) remains the open decision tracking POS's price-list scope model.
 */
export async function activatePriceList(pool: Pool, rawInput: ActivatePriceListInput): Promise<ActivatedPriceList> {
  const parsed = ActivatePriceListInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  const input = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Expire the current ACTIVE list first so the partial unique index never sees two ACTIVE rows.
    await client.query(
      `UPDATE core.price_list SET status = 'EXPIRED', updated_at = now()
       WHERE organization_id = $1 AND scope = $2 AND status = 'ACTIVE'`,
      [input.organizationId, input.scope],
    );

    const priceListId = randomUUID();
    const inserted = await client.query<{ version: number }>(
      `INSERT INTO core.price_list (id, organization_id, scope, status, valid_from)
       VALUES ($1, $2, $3, 'ACTIVE', $4)
       RETURNING version`,
      [priceListId, input.organizationId, input.scope, input.validFrom],
    );
    const version = inserted.rows[0]?.version;
    if (version === undefined) throw new Error('Price list insert did not return a version.');

    for (const item of input.items) {
      await client.query(
        `INSERT INTO core.price_list_item (id, price_list_id, product_id, uom, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), priceListId, item.productId, item.uom, item.unitPrice],
      );
    }

    await client.query('COMMIT');
    return { priceListId, version };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
