import type { Queryable } from './queries';

/**
 * Back-office reads over counter sales (Penjualan, the dashboard tile). Only checked-out sales
 * appear: a cart has no invoice and is not yet a sale. Dates are business dates in Asia/Jakarta
 * (AGENTS.md §11.1). Scope is applied in SQL through `warehouseIds`, so a page is always a full
 * page of rows the caller may see.
 */
export interface PosSalesListFilter {
  organizationId: string;
  warehouseIds: readonly string[];
  allWarehouses: boolean;
  fromDate: string;
  toDate: string;
  shiftId?: string;
  cashierUserId?: string;
  limit: number;
  offset: number;
}

export interface PosSalesListItem {
  saleId: string; invoiceNumber: string; status: string; total: string; checkedOutAt: string; paidAt: string | null;
  handedOverAt: string | null; shiftId: string; cashierUserId: string; terminalCode: string; terminalName: string;
  branchId: string; warehouseId: string;
}

function scope(filter: PosSalesListFilter, params: unknown[]): string {
  const clauses = ['sale.organization_id = $1', 'sale.invoice_number IS NOT NULL'];
  params.push(filter.fromDate, filter.toDate);
  clauses.push(`(sale.checked_out_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
  if (!filter.allWarehouses) { params.push(filter.warehouseIds); clauses.push(`t.warehouse_id = ANY($${params.length}::uuid[])`); }
  if (filter.shiftId) { params.push(filter.shiftId); clauses.push(`sale.shift_id = $${params.length}`); }
  if (filter.cashierUserId) { params.push(filter.cashierUserId); clauses.push(`s.cashier_user_id = $${params.length}`); }
  return clauses.join(' AND ');
}

const from = `FROM pos.pos_sale sale JOIN pos.pos_shift s ON s.id = sale.shift_id JOIN pos.pos_terminal t ON t.id = sale.terminal_id`;

export async function listPosSales(executor: Queryable, filter: PosSalesListFilter): Promise<{ items: PosSalesListItem[]; total: number }> {
  const params: unknown[] = [filter.organizationId];
  const where = scope(filter, params);
  const total = await executor.query<{ total: number }>(`SELECT count(*)::int AS total ${from} WHERE ${where}`, params);
  const rows = await executor.query<{
    id: string; invoice_number: string; status: string; total: string; checked_out_at: Date; paid_at: Date | null;
    handed_over_at: Date | null; shift_id: string; cashier_user_id: string; code: string; name: string; branch_id: string; warehouse_id: string;
  }>(
    `SELECT sale.id, sale.invoice_number, sale.status, sale.total::text, sale.checked_out_at, sale.paid_at, sale.handed_over_at,
            sale.shift_id, s.cashier_user_id, t.code, t.name, t.branch_id, t.warehouse_id
     ${from} WHERE ${where}
     ORDER BY sale.checked_out_at DESC, sale.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.limit, filter.offset],
  );
  return {
    total: total.rows[0]!.total,
    items: rows.rows.map((row) => ({
      saleId: row.id, invoiceNumber: row.invoice_number, status: row.status, total: row.total,
      checkedOutAt: row.checked_out_at.toISOString(), paidAt: row.paid_at?.toISOString() ?? null,
      handedOverAt: row.handed_over_at?.toISOString() ?? null, shiftId: row.shift_id, cashierUserId: row.cashier_user_id,
      terminalCode: row.code, terminalName: row.name, branchId: row.branch_id, warehouseId: row.warehouse_id,
    })),
  };
}

/** One checked-out sale in the list's shape, for the back-office detail. The caller authorizes it. */
export async function getPosSalesListItem(executor: Queryable, saleId: string): Promise<PosSalesListItem | null> {
  const rows = await executor.query<{
    id: string; invoice_number: string; status: string; total: string; checked_out_at: Date; paid_at: Date | null;
    handed_over_at: Date | null; shift_id: string; cashier_user_id: string; code: string; name: string; branch_id: string; warehouse_id: string;
  }>(
    `SELECT sale.id, sale.invoice_number, sale.status, sale.total::text, sale.checked_out_at, sale.paid_at, sale.handed_over_at,
            sale.shift_id, s.cashier_user_id, t.code, t.name, t.branch_id, t.warehouse_id
     ${from} WHERE sale.id = $1 AND sale.invoice_number IS NOT NULL`, [saleId],
  );
  const row = rows.rows[0];
  return row ? {
    saleId: row.id, invoiceNumber: row.invoice_number, status: row.status, total: row.total,
    checkedOutAt: row.checked_out_at.toISOString(), paidAt: row.paid_at?.toISOString() ?? null,
    handedOverAt: row.handed_over_at?.toISOString() ?? null, shiftId: row.shift_id, cashierUserId: row.cashier_user_id,
    terminalCode: row.code, terminalName: row.name, branchId: row.branch_id, warehouseId: row.warehouse_id,
  } : null;
}

/** Today's counter sales for the dashboard: sales paid on `businessDate`, whether or not the goods were collected yet. */
export async function getPosSalesSummary(executor: Queryable, input: {
  organizationId: string; warehouseIds: readonly string[]; allWarehouses: boolean; businessDate: string;
}): Promise<{ salesTotal: string; saleCount: number }> {
  const params: unknown[] = [input.organizationId, input.businessDate];
  const warehouseClause = input.allWarehouses ? '' : ` AND t.warehouse_id = ANY($${params.push(input.warehouseIds)}::uuid[])`;
  const result = await executor.query<{ sales_total: string; sale_count: number }>(
    `SELECT COALESCE(SUM(sale.total), 0)::numeric(18,2)::text AS sales_total, count(*)::int AS sale_count
     FROM pos.pos_sale sale JOIN pos.pos_terminal t ON t.id = sale.terminal_id
     WHERE sale.organization_id = $1 AND sale.status IN ('PAID', 'HANDED_OVER')
       AND (sale.paid_at AT TIME ZONE 'Asia/Jakarta')::date = $2::date${warehouseClause}`,
    params,
  );
  return { salesTotal: result.rows[0]!.sales_total, saleCount: result.rows[0]!.sale_count };
}
