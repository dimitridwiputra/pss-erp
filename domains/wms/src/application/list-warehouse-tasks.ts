import type { Pool } from 'pg';
import { z } from 'zod';

const ListWarehouseTasksInputSchema = z.strictObject({
  warehouseId: z.uuid(),
  type: z.enum(['RECEIVE', 'PUTAWAY', 'PICK', 'COUNT', 'PACK', 'STAGE', 'LOAD']).optional(),
  status: z.enum(['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_SHORT', 'CANCELLED']).optional(),
  limit: z.number().int().positive().max(500).default(100),
});
export type ListWarehouseTasksInput = z.input<typeof ListWarehouseTasksInputSchema>;

export interface WarehouseTaskSummary {
  taskId: string;
  type: string;
  status: string;
  locationCode: string | null;
  productId: string | null;
  uom: string | null;
  qtyExpected: string | null;
  qtyConfirmed: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Read-only: a filterable list of tasks for one warehouse, most recently updated first — the data behind an "Antrian Tugas Operasional" admin table. */
export async function listWarehouseTasks(pool: Pool, input: ListWarehouseTasksInput): Promise<WarehouseTaskSummary[]> {
  const parsed = ListWarehouseTasksInputSchema.parse(input);
  const conditions = ['t.warehouse_id = $1'];
  const params: unknown[] = [parsed.warehouseId];
  if (parsed.type) { params.push(parsed.type); conditions.push(`t.type = $${params.length}`); }
  if (parsed.status) { params.push(parsed.status); conditions.push(`t.status = $${params.length}`); }
  params.push(parsed.limit);

  const result = await pool.query<{
    id: string; type: string; status: string; location_code: string | null; product_id: string | null; uom: string | null;
    qty_expected: string | null; qty_confirmed: string | null; assignee_user_id: string | null; created_at: string; updated_at: string;
  }>(
    `SELECT t.id, t.type, t.status, wl.code AS location_code, t.product_id, t.uom, t.qty_expected, t.qty_confirmed, t.assignee_user_id, t.created_at, t.updated_at
     FROM wms.warehouse_task t LEFT JOIN wms.warehouse_location wl ON wl.id = t.location_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.updated_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    taskId: row.id, type: row.type, status: row.status, locationCode: row.location_code, productId: row.product_id, uom: row.uom,
    qtyExpected: row.qty_expected, qtyConfirmed: row.qty_confirmed, assigneeUserId: row.assignee_user_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}
