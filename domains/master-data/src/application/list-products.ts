import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '@pss/contracts';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const ListProductsInputSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Matches SKU or name. Wildcards typed by the operator are escaped rather than honoured. */
  query: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
  page: z.number().int().positive().max(10_000).optional(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  sort: z.enum(['name', 'sku', 'createdAt']).optional(),
});

export type ListProductsInput = z.input<typeof ListProductsInputSchema>;

export interface ProductListRow {
  productId: string;
  sku: string;
  name: string;
  baseUom: string;
  status: string;
  /** How many units the product sells, so a list row can say "PCS, KARTON" without a second call. */
  unitCount: number;
  hasBarcode: boolean;
  createdAt: string;
}

export interface ProductPage {
  items: ProductListRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** Each sortable column is named by this map, never by the caller's string reaching the SQL. */
const SORT_COLUMNS = { name: 'p.name', sku: 'p.sku', createdAt: 'p.created_at' } as const;

/** Escapes ILIKE wildcards so a literal `%`/`_` in the search box is not a pattern. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The back office's product list: paginated, searchable, with the two facts a row needs to be
 * actionable — how many units it sells and whether it can be scanned.
 *
 * `unitCount` and `hasBarcode` come from correlated subqueries over this domain's own tables rather
 * than a join and a count per row, so a 100-row page is one query. Read-only, so no audit entry
 * (AGENTS.md §14 covers mutations).
 *
 * `searchProducts` remains the counter's katalog read: it has no pagination and no unit information,
 * and changing its shape would reach into `domains/pos`.
 */
export async function listProducts(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ListProductsInput,
): Promise<ProductPage> {
  const input = parseCommandInput(ListProductsInputSchema, rawInput);
  const runner = client ?? pool;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortColumn = SORT_COLUMNS[input.sort ?? 'name'];

  const conditions = ['p.organization_id = $1'];
  const values: unknown[] = [input.organizationId];
  if (input.query) {
    values.push(likePattern(input.query));
    conditions.push(`(p.sku ILIKE $${values.length} ESCAPE '\\' OR p.name ILIKE $${values.length} ESCAPE '\\')`);
  }
  if (input.status) {
    values.push(input.status);
    conditions.push(`p.status = $${values.length}`);
  }
  const where = conditions.join(' AND ');

  const counted = await runner.query<{ total: string }>(
    `SELECT count(*) AS total FROM core.product p WHERE ${where}`, values,
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  const offset = (page - 1) * pageSize;

  const rows = await runner.query<{
    id: string; sku: string; name: string; base_uom: string; status: string; created_at: Date;
    unit_count: number; has_barcode: boolean;
  }>(
    `SELECT p.id, p.sku, p.name, p.base_uom, p.status, p.created_at,
            (SELECT count(*)::int FROM core.product_uom u WHERE u.product_id = p.id) AS unit_count,
            EXISTS (SELECT 1 FROM core.product_barcode b WHERE b.product_id = p.id) AS has_barcode
     FROM core.product p
     WHERE ${where}
     ORDER BY ${sortColumn} ASC, p.id ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset],
  );

  return {
    items: rows.rows.map((row) => ({
      productId: row.id,
      sku: row.sku,
      name: row.name,
      baseUom: row.base_uom,
      status: row.status,
      unitCount: row.unit_count,
      hasBarcode: row.has_barcode,
      createdAt: row.created_at.toISOString(),
    })),
    page,
    pageSize,
    total,
    hasMore: offset + rows.rows.length < total,
  };
}
