import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export type CashCustodyStatus = 'DECLARED' | 'VERIFIED' | 'DISCREPANCY' | 'RESOLVED';

export interface CashCustodyRecordView {
  id: string;
  organizationId: string;
  branchId: string | null;
  source:'POS_SHIFT' | 'SFA' | 'FLEET';
  sourceId: string | null;
  collectorId: string;
  declaredAmount: string;
  countedAmount: string | null;
  varianceAmount: string | null;
  reasonCode: string | null;
  status: CashCustodyStatus;
  verifiedBy: string | null;
  verifiedAt: string | null;
  declaredAt: string;
  paymentCount: number;
}

interface Row {
  id: string; organization_id: string; branch_id: string | null; source: CashCustodyRecordView['source']; source_id: string | null; collector_id: string;
  declared_amount: string; counted_amount: string | null; variance: string | null; reason_code: string | null;
  status: CashCustodyStatus; verified_by: string | null; verified_at: Date | null; created_at: Date; payment_count: number;
}

const columns = `r.id, r.organization_id, r.branch_id, r.source, r.source_id, r.collector_id, r.declared_amount::text, r.counted_amount::text,
  (r.counted_amount - r.declared_amount)::numeric(18,2)::text AS variance, r.reason_code, r.status, r.verified_by, r.verified_at,
  r.created_at, (SELECT count(*)::int FROM payments.cash_custody_payment p WHERE p.cash_custody_record_id = r.id) AS payment_count`;

function toView(row: Row): CashCustodyRecordView {
  return {
    id: row.id, organizationId: row.organization_id, branchId: row.branch_id, source: row.source, sourceId: row.source_id, collectorId: row.collector_id,
    declaredAmount: row.declared_amount, countedAmount: row.counted_amount, varianceAmount: row.variance, reasonCode: row.reason_code,
    status: row.status, verifiedBy: row.verified_by, verifiedAt: row.verified_at?.toISOString() ?? null,
    declaredAt: row.created_at.toISOString(), paymentCount: row.payment_count,
  };
}

/**
 * Cash handovers of one organization, newest declaration first, one page at a time, limited to
 * `branchIds` (the branches where the caller may verify) unless `allBranches`. The status is an
 * allow-listed filter, never free SQL (AGENTS.md §9).
 */
export async function listCashCustodyRecords(executor: Queryable, input: {
  organizationId: string; branchIds: readonly string[]; allBranches: boolean; status?: CashCustodyStatus; limit: number; offset: number;
}): Promise<{ items: CashCustodyRecordView[]; total: number }> {
  const params: unknown[] = [input.organizationId];
  let filter = '';
  if (!input.allBranches) { params.push(input.branchIds); filter += ` AND r.branch_id = ANY($${params.length}::uuid[])`; }
  if (input.status) { params.push(input.status); filter += ` AND r.status = $${params.length}`; }
  const total = await executor.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM payments.cash_custody_record r WHERE r.organization_id = $1 ${filter}`, params,
  );
  const rows = await executor.query<Row>(
    `SELECT ${columns} FROM payments.cash_custody_record r WHERE r.organization_id = $1 ${filter}
     ORDER BY r.created_at DESC, r.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, input.limit, input.offset],
  );
  return { items: rows.rows.map(toView), total: total.rows[0]!.total };
}

export async function getCashCustodyRecord(executor: Queryable, id: string): Promise<CashCustodyRecordView | null> {
  const rows = await executor.query<Row>(`SELECT ${columns} FROM payments.cash_custody_record r WHERE r.id = $1`, [id]);
  return rows.rows[0] ? toView(rows.rows[0]) : null;
}

/**
 * Counter cash Finance has not yet counted: every POS TUNAI payment still PENDING_VERIFICATION,
 * whether or not the cashier has declared it yet, in `branchIds` unless `allBranches`. Feeds the
 * "kas belum disetor" dashboard tile.
 */
export async function getUndepositedPosCash(executor: Queryable, input: {
  organizationId: string; branchIds: readonly string[]; allBranches: boolean;
}): Promise<{ amount: string; paymentCount: number }> {
  const params: unknown[] = [input.organizationId];
  const branchClause = input.allBranches ? '' : ` AND branch_id = ANY($${params.push(input.branchIds)}::uuid[])`;
  const result = await executor.query<{ amount: string; payment_count: number }>(
    `SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text AS amount, count(*)::int AS payment_count
     FROM payments.payment
     WHERE organization_id = $1 AND channel = 'POS' AND method = 'TUNAI' AND status = 'PENDING_VERIFICATION'${branchClause}`,
    params,
  );
  return { amount: result.rows[0]!.amount, paymentCount: result.rows[0]!.payment_count };
}
