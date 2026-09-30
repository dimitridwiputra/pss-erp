import type { Pool, PoolClient } from 'pg';
import { DomainError } from '@pss/contracts';
import { z } from 'zod';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const ListPriceListItemsInputSchema = z.strictObject({
  organizationId: z.uuid(),
  priceListId: z.uuid(),
  /** Matches the product id or the unit. The product's name is `master-data`'s fact, not this one's. */
  query: z.string().trim().max(100).optional(),
  productId: z.uuid().optional(),
  page: z.number().int().positive().max(10_000).optional(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  sort: z.enum(['product', 'unitPrice']).optional(),
});

export type ListPriceListItemsInput = z.input<typeof ListPriceListItemsInputSchema>;

export interface PriceListItemRow {
  priceListItemId: string;
  productId: string;
  uom: string;
  unitPrice: string;
}

export interface PriceListItemPage {
  priceListId: string;
  status: string;
  version: number;
  validFrom: string;
  items: PriceListItemRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** Each sortable column is named by this map, never by the caller's string reaching the SQL. */
const SORT_COLUMNS = { product: 'product_id', unitPrice: 'unit_price' } as const;

/**
 * COM-001's item list for one price list, with the list's own status and version so a screen can show
 * "Harga KONTER versi 14 — belum aktif" without a second call.
 *
 * It returns `productId` and not a product name. `core.product` is `master-data`'s table and a name
 * read from here would be a cross-domain database read (AGENTS.md §3.1); a caller that needs names
 * asks `master-data` for them and joins the two answers in the API layer, which is where composition
 * belongs.
 */
export async function listPriceListItems(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ListPriceListItemsInput,
): Promise<PriceListItemPage> {
  const input = parseCommandInput(ListPriceListItemsInputSchema, rawInput);
  const runner = client ?? pool;
  const page = input.page ?? 1;
  // The schema already caps `pageSize` at MAX_PAGE_SIZE, so the default is the only bound left.
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortColumn = SORT_COLUMNS[input.sort ?? 'product'];

  const list = await runner.query<{ status: string; version: number; valid_from: string }>(
    // `to_char`, not the bare column: pg parses a `date` into a JS Date, and this contract is a
    // `BusinessDate` string.
    `SELECT status, version, to_char(valid_from, 'YYYY-MM-DD') AS valid_from
     FROM core.price_list WHERE id = $1 AND organization_id = $2`,
    [input.priceListId, input.organizationId],
  );
  const row = list.rows[0];
  if (!row) throw new DomainError('NOT_FOUND');

  const conditions = ['price_list_id = $1'];
  const values: unknown[] = [input.priceListId];
  if (input.productId) {
    values.push(input.productId);
    conditions.push(`product_id = $${values.length}`);
  }
  if (input.query) {
    values.push(`%${input.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    conditions.push(`(product_id::text ILIKE $${values.length} ESCAPE '\\' OR uom ILIKE $${values.length} ESCAPE '\\')`);
  }
  const where = conditions.join(' AND ');

  const counted = await runner.query<{ total: string }>(
    `SELECT count(*) AS total FROM core.price_list_item WHERE ${where}`, values,
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  const offset = (page - 1) * pageSize;

  const rows = await runner.query<{ id: string; product_id: string; uom: string; unit_price: string }>(
    `SELECT id, product_id, uom, unit_price FROM core.price_list_item
     WHERE ${where}
     ORDER BY ${sortColumn} ${input.sort === 'unitPrice' ? 'DESC' : 'ASC'}, id ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset],
  );

  return {
    priceListId: input.priceListId,
    status: row.status,
    version: row.version,
    validFrom: row.valid_from,
    items: rows.rows.map((item) => ({
      priceListItemId: item.id, productId: item.product_id, uom: item.uom, unitPrice: item.unit_price,
    })),
    page,
    pageSize,
    total,
    hasMore: offset + rows.rows.length < total,
  };
}
