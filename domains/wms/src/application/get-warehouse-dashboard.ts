import type { Pool } from 'pg';
import { z } from 'zod';

const GetWarehouseDashboardInputSchema = z.strictObject({
  warehouseId: z.uuid(),
  stuckAfterMinutes: z.number().int().positive().default(30),
  activeWithinMinutes: z.number().int().positive().default(5),
});
export type GetWarehouseDashboardInput = z.input<typeof GetWarehouseDashboardInputSchema>;

export interface StuckTask {
  taskId: string;
  type: string;
  status: string;
  minutesSinceUpdate: number;
  assigneeUserId: string | null;
}

export interface WarehouseDashboard {
  asOf: string;
  taskCounts: Array<{ type: string; status: string; count: number }>;
  shortToday: number;
  discrepanciesPendingReview: number;
  cycleCountsPendingReview: number;
  activeOperatorCount: number;
  openExceptionCount: number;
  stuckTasks: StuckTask[];
  pickAccuracyToday: number | null;
  throughputPerHourToday: Array<{ hour: number; count: number }>;
}

/**
 * WMS-015 (simplified): the PRD requires this dashboard to read from a projected `reporting` read
 * model, never live transaction tables (WMS-015.NC01), so that dashboard queries never contend
 * with write traffic and stay decoupled from `wms`'s own schema changes. This slice deliberately
 * does not build that — no outbox events are published by any WMS command yet, and standing up an
 * outbox -> queue -> reporting-projector pipeline for a single P2 read-only view is not justified
 * without real query-load data. This query aggregates directly over this domain's own tables
 * instead (still same-domain access, not cross-domain) and is honestly out of spec on NC01 until
 * that pipeline is built — tracked here, not silently glossed over. `asOf` is simply "now" (a live
 * query has no projection lag), which is stricter freshness than the spec anticipates, not looser.
 *
 * "Petugas aktif" (`activeOperatorCount`) is real, from `wms.operator_session` heartbeats — not
 * simulated. "Tugas macet" (`stuckTasks`) is a genuine query: any `ASSIGNED`/`IN_PROGRESS` task
 * whose `updated_at` has not moved in `stuckAfterMinutes`. `pickAccuracyToday` is
 * `1 - (shortPicks / totalPicks)` over today's completed `PICK` tasks (`null` when there were
 * none to divide by, rather than a misleading 100%). "FR menunggu" (fulfillment requests waiting)
 * is still not implemented — no fulfillment-request integration exists in this domain.
 */
export async function getWarehouseDashboard(pool: Pool, input: GetWarehouseDashboardInput): Promise<WarehouseDashboard> {
  const parsed = GetWarehouseDashboardInputSchema.parse(input);

  const taskCounts = await pool.query<{ type: string; status: string; count: string }>(
    `SELECT type, status, count(*)::text AS count FROM wms.warehouse_task WHERE warehouse_id = $1 GROUP BY type, status`,
    [parsed.warehouseId],
  );

  const shortToday = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND status = 'COMPLETED_SHORT' AND updated_at::date = current_date`,
    [parsed.warehouseId],
  );

  const discrepanciesPendingReview = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wms.stock_discrepancy_report WHERE warehouse_id = $1 AND status = 'REPORTED'`,
    [parsed.warehouseId],
  );

  const cycleCountsPendingReview = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wms.stock_discrepancy_report r
     JOIN wms.warehouse_task t ON t.id = r.source_task_id
     WHERE r.warehouse_id = $1 AND r.status = 'REPORTED' AND t.type = 'COUNT'`,
    [parsed.warehouseId],
  );

  const activeOperators = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wms.operator_session WHERE warehouse_id = $1 AND last_seen_at > now() - ($2 || ' minutes')::interval`,
    [parsed.warehouseId, parsed.activeWithinMinutes],
  );

  const openExceptions = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wms.exception_queue WHERE warehouse_id = $1 AND status != 'RESOLVED'`,
    [parsed.warehouseId],
  );

  const stuckTasks = await pool.query<{ id: string; type: string; status: string; minutes: string; assignee_user_id: string | null }>(
    `SELECT id, type, status, EXTRACT(EPOCH FROM (now() - updated_at))::int / 60 AS minutes, assignee_user_id
     FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND status IN ('ASSIGNED', 'IN_PROGRESS') AND updated_at < now() - ($2 || ' minutes')::interval
     ORDER BY updated_at ASC`,
    [parsed.warehouseId, parsed.stuckAfterMinutes],
  );

  const pickStatsToday = await pool.query<{ total: string; short: string }>(
    `SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'COMPLETED_SHORT')::text AS short
     FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND type = 'PICK' AND status IN ('COMPLETED', 'COMPLETED_SHORT') AND updated_at::date = current_date`,
    [parsed.warehouseId],
  );
  const totalPicksToday = Number(pickStatsToday.rows[0]?.total ?? '0');

  const throughput = await pool.query<{ hour: string; count: string }>(
    `SELECT EXTRACT(HOUR FROM updated_at)::text AS hour, count(*)::text AS count
     FROM wms.warehouse_task
     WHERE warehouse_id = $1 AND type = 'PICK' AND status IN ('COMPLETED', 'COMPLETED_SHORT') AND updated_at::date = current_date
     GROUP BY EXTRACT(HOUR FROM updated_at) ORDER BY hour ASC`,
    [parsed.warehouseId],
  );

  return {
    asOf: new Date().toISOString(),
    taskCounts: taskCounts.rows.map((row) => ({ type: row.type, status: row.status, count: Number(row.count) })),
    shortToday: Number(shortToday.rows[0]!.count),
    discrepanciesPendingReview: Number(discrepanciesPendingReview.rows[0]!.count),
    cycleCountsPendingReview: Number(cycleCountsPendingReview.rows[0]!.count),
    activeOperatorCount: Number(activeOperators.rows[0]!.count),
    openExceptionCount: Number(openExceptions.rows[0]!.count),
    stuckTasks: stuckTasks.rows.map((row) => ({ taskId: row.id, type: row.type, status: row.status, minutesSinceUpdate: Number(row.minutes), assigneeUserId: row.assignee_user_id })),
    pickAccuracyToday: totalPicksToday === 0 ? null : 1 - Number(pickStatsToday.rows[0]!.short) / totalPicksToday,
    throughputPerHourToday: throughput.rows.map((row) => ({ hour: Number(row.hour), count: Number(row.count) })),
  };
}
