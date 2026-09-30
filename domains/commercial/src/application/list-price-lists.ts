import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '@pss/contracts';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const ListPriceListsInputSchema = z.strictObject({
  organizationId: z.uuid(),
  scope: z.string().min(1).max(64).optional(),
  page: z.number().int().positive().max(10_000).optional(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
});

export type ListPriceListsInput = z.input<typeof ListPriceListsInputSchema>;

export interface PriceListSummaryRow {
  priceListId: string;
  scope: string;
  status: string;
  version: number;
  validFrom: string;
  itemCount: number;
  createdAt: string;
}

export interface PriceListPage {
  items: PriceListSummaryRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /** The scope's live list, so a screen can say what price is in effect right now. */
  activePriceListId: string | null;
}

export interface ListPriceListsResult extends PriceListPage {
  /** Every scope the organization has a list for, so the filter can offer them. */
  scopes: string[];
}

/**
 * The versions of a price-list scope, newest first, with the ACTIVE one flagged.
 *
 * `validFrom` is formatted in SQL because `pg` turns a `date` column into a JS `Date`, and this
 * domain's contracts speak `BusinessDate` strings.
 *
 * `activePriceListId` is the first ACTIVE list by version. The partial unique index guarantees at most
 * one per scope, so "first" is only a tiebreak for a database that somehow holds two.
 */
export async function listPriceLists(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ListPriceListsInput,
): Promise<ListPriceListsResult> {
  const input = parseCommandInput(ListPriceListsInputSchema, rawInput);
  const runner = client ?? pool;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;

  const scopes = await runner.query<{ scope: string }>(
    'SELECT DISTINCT scope FROM core.price_list WHERE organization_id = $1 ORDER BY scope',
    [input.organizationId],
  );
  const active = await runner.query<{ id: string }>(
    `SELECT id FROM core.price_list
     WHERE organization_id = $1 AND status = 'ACTIVE' ${input.scope ? 'AND scope = $2' : ''}
     ORDER BY version DESC LIMIT 1`,
    input.scope ? [input.organizationId, input.scope] : [input.organizationId],
  );

  const conditions = ['organization_id = $1'];
  const values: unknown[] = [input.organizationId];
  if (input.scope) {
    values.push(input.scope);
    conditions.push(`scope = $${values.length}`);
  }
  const where = conditions.join(' AND ');

  const counted = await runner.query<{ total: string }>(
    `SELECT count(*) AS total FROM core.price_list WHERE ${where}`, values,
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  const offset = (page - 1) * pageSize;

  const rows = await runner.query<{
    id: string; scope: string; status: string; version: number; valid_from: string; created_at: Date; item_count: number;
  }>(
    `SELECT pl.id, pl.scope, pl.status, pl.version,
            to_char(pl.valid_from, 'YYYY-MM-DD') AS valid_from, pl.created_at,
            (SELECT count(*)::int FROM core.price_list_item i WHERE i.price_list_id = pl.id) AS item_count
     FROM core.price_list pl
     WHERE ${where}
     ORDER BY pl.scope ASC, pl.version DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset],
  );

  return {
    items: rows.rows.map((row) => ({
      priceListId: row.id,
      scope: row.scope,
      status: row.status,
      version: row.version,
      validFrom: row.valid_from,
      itemCount: row.item_count,
      createdAt: row.created_at.toISOString(),
    })),
    page,
    pageSize,
    total,
    hasMore: offset + rows.rows.length < total,
    activePriceListId: active.rows[0]?.id ?? null,
    scopes: scopes.rows.map((row) => row.scope),
  };
}
