import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';

const HeartbeatInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  userId: z.uuid(),
  currentTaskId: z.uuid().optional(),
});
export type HeartbeatInput = z.input<typeof HeartbeatInputSchema>;

/**
 * A real (not audited — this is a presence ping, not a business mutation) upsert of "this
 * operator's device is alive right now". No mandatory-audit boundary applies here on purpose:
 * a heartbeat is expected to fire every few seconds and would flood the audit log for no
 * business value if it went through `@pss/audit`.
 */
export async function heartbeatOperatorSession(pool: Pool, input: HeartbeatInput): Promise<{ ok: true }> {
  const parsed = HeartbeatInputSchema.parse(input);
  await pool.query(
    `INSERT INTO wms.operator_session (id, organization_id, warehouse_id, user_id, current_task_id, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (warehouse_id, user_id) DO UPDATE SET current_task_id = $5, last_seen_at = now()`,
    [randomUUID(), parsed.organizationId, parsed.warehouseId, parsed.userId, parsed.currentTaskId ?? null],
  );
  return { ok: true };
}

const GetActiveOperatorsInputSchema = z.strictObject({
  warehouseId: z.uuid(),
  activeWithinMinutes: z.number().int().positive().default(5),
});
export type GetActiveOperatorsInput = z.input<typeof GetActiveOperatorsInputSchema>;

export interface ActiveOperator {
  userId: string;
  online: boolean;
  lastSeenAt: string;
  currentTaskType: string | null;
}

/**
 * "Online" means a heartbeat landed within `activeWithinMinutes`; every operator with a session
 * row at all is returned (online or not) so a caller can show a real "N online / M total seen
 * today" count rather than only ever showing the online ones.
 */
export async function getActiveOperators(pool: Pool, input: GetActiveOperatorsInput): Promise<ActiveOperator[]> {
  const parsed = GetActiveOperatorsInputSchema.parse(input);
  const result = await pool.query<{ user_id: string; last_seen_at: string; task_type: string | null }>(
    `SELECT s.user_id, s.last_seen_at, t.type AS task_type
     FROM wms.operator_session s LEFT JOIN wms.warehouse_task t ON t.id = s.current_task_id
     WHERE s.warehouse_id = $1 AND s.last_seen_at > now() - interval '1 day'
     ORDER BY s.last_seen_at DESC`,
    [parsed.warehouseId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    online: new Date(row.last_seen_at).getTime() > Date.now() - parsed.activeWithinMinutes * 60_000,
    lastSeenAt: row.last_seen_at,
    currentTaskType: row.task_type,
  }));
}
