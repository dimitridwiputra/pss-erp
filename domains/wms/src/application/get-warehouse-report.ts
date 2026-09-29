import type { Pool } from 'pg';
import { z } from 'zod';

const GetWarehouseReportInputSchema = z.strictObject({
  warehouseId: z.uuid(),
  fromDate: z.iso.date(),
  toDate: z.iso.date(),
  putawaySlaMinutes: z.number().int().positive().default(60),
});
export type GetWarehouseReportInput = z.input<typeof GetWarehouseReportInputSchema>;

export interface WarehouseReportKpis {
  receivingTurnaroundAvgMinutes: number | null;
  putawaySlaPct: number | null;
  pickAccuracyPct: number | null;
  shortRatePct: number | null;
  cycleCountAccuracyPct: number | null;
  tasksPerActiveOperator: number | null;
}

export interface WarehouseReportDetailRow {
  taskId: string;
  type: string;
  status: string;
  locationCode: string | null;
  productId: string | null;
  qtyExpected: string | null;
  qtyConfirmed: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseReport {
  warehouseId: string;
  fromDate: string;
  toDate: string;
  kpis: WarehouseReportKpis;
  throughputTrend: Array<{ date: string; type: string; count: number }>;
  taskTypeComposition: Array<{ type: string; count: number }>;
  shortReasonDistribution: Array<{ reasonCode: string; count: number }>;
  detailRows: WarehouseReportDetailRow[];
}

/**
 * WMS-015's "Laporan Gudang". Every figure here is computed directly from `wms.warehouse_task`
 * (and `warehouse_location` for codes) over the given date range — nothing is simulated.
 * `tasksPerActiveOperator` stands in for the reference's "Utilization (Task Hour)" card: this
 * domain has no shift/labor-hours tracking to compute a true busy-time/available-time percentage
 * against, so this reports completed tasks per distinct operator who did at least one task in the
 * range instead — a real, if narrower, productivity proxy, not a fabricated utilization %.
 * "Produktivitas per Zona" (per-zone breakdown) is not implemented — `warehouse_location` has no
 * first-class "zone" grouping independent of its parent-hierarchy, which is not a reliable zone
 * boundary to group by.
 */
export async function getWarehouseReport(pool: Pool, input: GetWarehouseReportInput): Promise<WarehouseReport> {
  const parsed = GetWarehouseReportInputSchema.parse(input);
  const range = { warehouseId: parsed.warehouseId, from: parsed.fromDate, to: parsed.toDate };

  const receivingTurnaround = await pool.query<{ avg_minutes: string | null }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60)::text AS avg_minutes
     FROM wms.warehouse_task WHERE warehouse_id = $1 AND type = 'RECEIVE' AND created_at::date BETWEEN $2 AND $3`,
    [range.warehouseId, range.from, range.to],
  );

  const putaway = await pool.query<{ total: string; within_sla: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE EXTRACT(EPOCH FROM (updated_at - created_at)) / 60 <= $4)::text AS within_sla
     FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND type = 'PUTAWAY' AND status IN ('COMPLETED', 'COMPLETED_SHORT') AND created_at::date BETWEEN $2 AND $3`,
    [range.warehouseId, range.from, range.to, parsed.putawaySlaMinutes],
  );
  const putawayTotal = Number(putaway.rows[0]?.total ?? '0');

  const pick = await pool.query<{ total: string; short: string }>(
    `SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'COMPLETED_SHORT')::text AS short
     FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND type = 'PICK' AND status IN ('COMPLETED', 'COMPLETED_SHORT') AND created_at::date BETWEEN $2 AND $3`,
    [range.warehouseId, range.from, range.to],
  );
  const pickTotal = Number(pick.rows[0]?.total ?? '0');

  const allShort = await pool.query<{ total: string; short: string }>(
    `SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'COMPLETED_SHORT')::text AS short
     FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND status IN ('COMPLETED', 'COMPLETED_SHORT') AND created_at::date BETWEEN $2 AND $3`,
    [range.warehouseId, range.from, range.to],
  );
  const allTotal = Number(allShort.rows[0]?.total ?? '0');

  const cycleCount = await pool.query<{ total: string; with_variance: string }>(
    `SELECT count(DISTINCT t.id)::text AS total, count(DISTINCT r.source_task_id)::text AS with_variance
     FROM wms.warehouse_task t LEFT JOIN wms.stock_discrepancy_report r ON r.source_task_id = t.id
     WHERE t.warehouse_id = $1 AND t.type = 'COUNT' AND t.created_at::date BETWEEN $2 AND $3`,
    [range.warehouseId, range.from, range.to],
  );
  const cycleCountTotal = Number(cycleCount.rows[0]?.total ?? '0');

  const operatorTaskCounts = await pool.query<{ operators: string; tasks: string }>(
    `SELECT count(DISTINCT assignee_user_id)::text AS operators, count(*)::text AS tasks
     FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND status IN ('COMPLETED', 'COMPLETED_SHORT') AND assignee_user_id IS NOT NULL AND created_at::date BETWEEN $2 AND $3`,
    [range.warehouseId, range.from, range.to],
  );
  const operatorCount = Number(operatorTaskCounts.rows[0]?.operators ?? '0');

  const throughputTrend = await pool.query<{ date: string; type: string; count: string }>(
    `SELECT created_at::date::text AS date, type, count(*)::text AS count
     FROM wms.warehouse_task WHERE warehouse_id = $1 AND created_at::date BETWEEN $2 AND $3
     GROUP BY created_at::date, type ORDER BY date ASC`,
    [range.warehouseId, range.from, range.to],
  );

  const taskTypeComposition = await pool.query<{ type: string; count: string }>(
    `SELECT type, count(*)::text AS count FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND created_at::date BETWEEN $2 AND $3 GROUP BY type ORDER BY count(*) DESC`,
    [range.warehouseId, range.from, range.to],
  );

  const shortReasons = await pool.query<{ reason_code: string; count: string }>(
    `SELECT short_reason_code AS reason_code, count(*)::text AS count FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND status = 'COMPLETED_SHORT' AND short_reason_code IS NOT NULL AND created_at::date BETWEEN $2 AND $3
     GROUP BY short_reason_code ORDER BY count(*) DESC`,
    [range.warehouseId, range.from, range.to],
  );

  const detailRows = await pool.query<{
    id: string; type: string; status: string; location_code: string | null; product_id: string | null;
    qty_expected: string | null; qty_confirmed: string | null; created_at: string; updated_at: string;
  }>(
    `SELECT t.id, t.type, t.status, wl.code AS location_code, t.product_id, t.qty_expected, t.qty_confirmed, t.created_at, t.updated_at
     FROM wms.warehouse_task t LEFT JOIN wms.warehouse_location wl ON wl.id = t.location_id
     WHERE t.warehouse_id = $1 AND t.created_at::date BETWEEN $2 AND $3
     ORDER BY t.created_at DESC LIMIT 500`,
    [range.warehouseId, range.from, range.to],
  );

  return {
    warehouseId: parsed.warehouseId,
    fromDate: parsed.fromDate,
    toDate: parsed.toDate,
    kpis: {
      receivingTurnaroundAvgMinutes: receivingTurnaround.rows[0]?.avg_minutes ? Number(receivingTurnaround.rows[0].avg_minutes) : null,
      putawaySlaPct: putawayTotal === 0 ? null : Number(putaway.rows[0]!.within_sla) / putawayTotal,
      pickAccuracyPct: pickTotal === 0 ? null : 1 - Number(pick.rows[0]!.short) / pickTotal,
      shortRatePct: allTotal === 0 ? null : Number(allShort.rows[0]!.short) / allTotal,
      cycleCountAccuracyPct: cycleCountTotal === 0 ? null : 1 - Number(cycleCount.rows[0]!.with_variance) / cycleCountTotal,
      tasksPerActiveOperator: operatorCount === 0 ? null : Number(operatorTaskCounts.rows[0]!.tasks) / operatorCount,
    },
    throughputTrend: throughputTrend.rows.map((row) => ({ date: row.date, type: row.type, count: Number(row.count) })),
    taskTypeComposition: taskTypeComposition.rows.map((row) => ({ type: row.type, count: Number(row.count) })),
    shortReasonDistribution: shortReasons.rows.map((row) => ({ reasonCode: row.reason_code, count: Number(row.count) })),
    detailRows: detailRows.rows.map((row) => ({
      taskId: row.id, type: row.type, status: row.status, locationCode: row.location_code, productId: row.product_id,
      qtyExpected: row.qty_expected, qtyConfirmed: row.qty_confirmed, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
  };
}
