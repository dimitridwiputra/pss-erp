import type { Pool, PoolClient } from 'pg';

export interface AdjustmentReason {
  code: string;
  /** Indonesian display text, so the Penyesuaian Stok form shows a sentence and not a code. */
  label: string;
}

/**
 * The active adjustment reasons, for the Penyesuaian Stok form's reason picker.
 *
 * `adjustStock` validates the code against this table, so a form that offers only what this returns
 * cannot submit a reason the command will reject.
 *
 * No organization parameter, because `inventory.stock_adjustment_reason` has no `organization_id`: the
 * vocabulary is platform-level (MVP-OD-15). That is a consequence of the open decision, not an
 * oversight — if principals may add their own reason codes, this query takes a scope and the reference
 * table grows one.
 */
export async function listAdjustmentReasons(pool: Pool, client?: PoolClient): Promise<AdjustmentReason[]> {
  const result = await (client ?? pool).query<{ code: string; label: string }>(
    'SELECT code, label FROM inventory.stock_adjustment_reason WHERE is_active ORDER BY label, code',
  );
  return result.rows.map((row) => ({ code: row.code, label: row.label }));
}
