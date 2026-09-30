import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const ListCustomersInputSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Matches code or name. Omit to list every customer. */
  query: z.string().trim().max(100).optional(),
  status: z.enum(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'INACTIVE', 'MERGED']).optional(),
  /** 1-based. */
  page: z.number().int().positive().max(10_000).optional(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  /**
   * Allow-listed rather than passed to SQL: an unknown field is a `VALIDATION_FAILED`, not a
   * silently ignored or interpolated sort (AGENTS.md §9).
   */
  sort: z.enum(['name', 'code', 'createdAt']).optional(),
});

export type ListCustomersInput = z.input<typeof ListCustomersInputSchema>;

export interface CustomerListItem {
  customerId: string;
  code: string;
  name: string;
  /** PERSONAL data: shown to back office, never written to a log (AGENTS.md §15). */
  phone: string | null;
  segment: string | null;
  status: string;
  isWalkIn: boolean;
  createdAt: string;
}

export interface CustomerPage {
  items: CustomerListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** Each sortable column is named by this map, never by the caller's string reaching the SQL. */
const SORT_COLUMNS = { name: 'name', code: 'code', createdAt: 'created_at' } as const;

/** Escapes ILIKE wildcards so a literal `%`/`_` typed into the search box is not a pattern. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * MDM-004: a paginated customer list for the back office, offset-paged because the total is shown
 * next to it and the dataset is one organization's master data, not a ledger.
 *
 * Read-only: no audit entry, and no write of any kind. A customer id in another organization is not
 * reachable from here at all — the filter is on `organization_id` rather than applied afterwards.
 */
export async function listCustomers(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ListCustomersInput,
): Promise<CustomerPage> {
  const input = parseCommandInput(ListCustomersInputSchema, rawInput);
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortColumn = SORT_COLUMNS[input.sort ?? 'name'];

  const conditions = ['organization_id = $1'];
  const values: unknown[] = [input.organizationId];
  if (input.query) {
    values.push(likePattern(input.query));
    conditions.push(`(code ILIKE $${values.length} ESCAPE '\\' OR name ILIKE $${values.length} ESCAPE '\\')`);
  }
  if (input.status) {
    values.push(input.status);
    conditions.push(`status = $${values.length}`);
  }
  const where = conditions.join(' AND ');

  const counted = await (client ?? pool).query<{ total: string }>(
    `SELECT count(*) AS total FROM core.customer WHERE ${where}`,
    values,
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  const offset = (page - 1) * pageSize;

  const rows = await (client ?? pool).query<{
    id: string; code: string; name: string; phone: string | null; segment: string | null;
    status: string; is_walk_in: boolean; created_at: Date;
  }>(
    `SELECT id, code, name, phone, segment, status, is_walk_in, created_at
     FROM core.customer
     WHERE ${where}
     ORDER BY ${sortColumn} ASC, id ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset],
  );

  return {
    items: rows.rows.map((row) => ({
      customerId: row.id,
      code: row.code,
      name: row.name,
      phone: row.phone,
      segment: row.segment,
      status: row.status,
      isWalkIn: row.is_walk_in,
      createdAt: row.created_at.toISOString(),
    })),
    page,
    pageSize,
    total,
    hasMore: offset + rows.rows.length < total,
  };
}
