import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '@pss/contracts';

const MAX_IDS = 200;

const GetProductsByIdsInputSchema = z.strictObject({
  organizationId: z.uuid(),
  productIds: z.array(z.uuid()).min(1).max(MAX_IDS),
});

export type GetProductsByIdsInput = z.input<typeof GetProductsByIdsInputSchema>;

export interface ProductSummary {
  productId: string;
  sku: string;
  name: string;
  baseUom: string;
}

/**
 * Several products at once, by id, for a caller that already holds the ids.
 *
 * The Harga screen has a page of price-list items — `product_id`, which is `commercial`'s plain
 * reference — and needs the SKU and name for each. Two answers are joined by asking the two domains
 * and combining them **here**, at the API layer, rather than by `commercial` reading `core.product`
 * (AGENTS.md §3.1) or the screen making one request per row.
 *
 * An id that is not in the caller's organization is simply absent from the map, so the caller cannot
 * tell a product in another organization from one that does not exist — and cannot use this to probe
 * for them. The `productIds` cap is what keeps one request from becoming a table scan of the catalog.
 */
export async function getProductsByIds(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: GetProductsByIdsInput,
): Promise<Map<string, ProductSummary>> {
  const input = parseCommandInput(GetProductsByIdsInputSchema, rawInput);
  const rows = await (client ?? pool).query<{ id: string; sku: string; name: string; base_uom: string }>(
    `SELECT id, sku, name, base_uom FROM core.product
     WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [input.organizationId, input.productIds],
  );
  return new Map(rows.rows.map((row) => [
    row.id,
    { productId: row.id, sku: row.sku, name: row.name, baseUom: row.base_uom },
  ]));
}
