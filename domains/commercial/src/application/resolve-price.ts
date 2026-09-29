import { DomainError } from '@pss/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const ResolvePriceInputSchema = z.strictObject({
  organizationId: z.uuid(),
  productId: z.uuid(),
  uom: z.string().min(1),
  priceListScope: z.string().min(1),
});

export type ResolvePriceInput = z.input<typeof ResolvePriceInputSchema>;

export interface ResolvedPrice {
  /** Postgres `numeric` comes back from `pg` as a string; keep it exact, never parse to float. */
  unitPrice: string;
  priceListId: string;
  priceListVersion: number;
}

/** Resolves the active price for one product/UOM within an organization's price-list scope. */
export async function resolvePrice(pool: Pool, rawInput: ResolvePriceInput): Promise<ResolvedPrice> {
  const parsed = ResolvePriceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  const input = parsed.data;

  const result = await pool.query<{
    unit_price: string;
    price_list_id: string;
    price_list_version: number;
  }>(
    `SELECT item.unit_price AS unit_price, list.id AS price_list_id, list.version AS price_list_version
     FROM core.price_list list
     JOIN core.price_list_item item ON item.price_list_id = list.id
     WHERE list.organization_id = $1 AND list.scope = $2 AND list.status = 'ACTIVE'
       AND item.product_id = $3 AND item.uom = $4`,
    [input.organizationId, input.priceListScope, input.productId, input.uom],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError('PRICE_NOT_FOUND');

  return {
    unitPrice: row.unit_price,
    priceListId: row.price_list_id,
    priceListVersion: row.price_list_version,
  };
}
