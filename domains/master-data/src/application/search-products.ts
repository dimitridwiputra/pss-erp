import type { Pool } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const SearchProductsInputSchema = z.strictObject({
  organizationId: z.uuid(),
  query: z.string().min(1).max(100),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});

export type SearchProductsInput = z.input<typeof SearchProductsInputSchema>;

export interface ProductSearchResult {
  productId: string;
  sku: string;
  name: string;
  status: string;
}

interface ProductSearchRow {
  id: string;
  sku: string;
  name: string;
  status: string;
}

/** Escapes ILIKE wildcards so a literal `%`/`_` typed by the user is not treated as a pattern. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Read model only (F1 scope): SKU/name lookup for counter/POS product search. */
export async function searchProducts(pool: Pool, rawInput: SearchProductsInput): Promise<ProductSearchResult[]> {
  const input = parseCommandInput(SearchProductsInputSchema, rawInput);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const result = await pool.query<ProductSearchRow>(
    `SELECT id, sku, name, status
     FROM core.product
     WHERE organization_id = $1 AND (sku ILIKE $2 ESCAPE '\\' OR name ILIKE $2 ESCAPE '\\')
     ORDER BY name
     LIMIT $3`,
    [input.organizationId, likePattern(input.query), limit],
  );
  return result.rows.map((row) => ({ productId: row.id, sku: row.sku, name: row.name, status: row.status }));
}
