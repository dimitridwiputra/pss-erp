import type { Pool } from 'pg';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { confirmPickTask } from './pick-task';
import { putawayStock } from './putaway-stock';

const ActorSchema = z.strictObject({ userId: z.uuid().optional(), roles: z.array(z.string().min(1)) });

const QueuedPickConfirmationSchema = z.strictObject({
  clientKey: z.string().min(1),
  kind: z.literal('PICK'),
  taskId: z.uuid(),
  scannedLocationCode: z.string().min(1),
  scannedProductId: z.uuid(),
  qtyConfirmed: DecimalStringSchema,
  shortReasonCode: z.string().min(1).optional(),
});

const QueuedPutawayConfirmationSchema = z.strictObject({
  clientKey: z.string().min(1),
  kind: z.literal('PUTAWAY'),
  taskId: z.uuid(),
  toLocationCode: z.string().min(1),
  qtyConfirmed: DecimalStringSchema,
});

const QueuedConfirmationSchema = z.discriminatedUnion('kind', [QueuedPickConfirmationSchema, QueuedPutawayConfirmationSchema]);

const SyncOfflineConfirmationsInputSchema = z.strictObject({
  actor: ActorSchema,
  confirmations: z.array(QueuedConfirmationSchema).min(1),
});
export type SyncOfflineConfirmationsInput = z.input<typeof SyncOfflineConfirmationsInputSchema>;

export interface OfflineConfirmationResult {
  clientKey: string;
  outcome: 'SAVED' | 'NEEDS_REVIEW';
  reason: string | null;
}

export interface SyncedOfflineConfirmations {
  status: 'APPLIED' | 'APPLIED_WITH_CONFLICTS';
  results: OfflineConfirmationResult[];
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_SHORT']);

/**
 * WMS-014: replays confirmations a handheld device queued while offline, in the order they were
 * confirmed on the device. Each one runs through the exact same `confirmPickTask`/`putawayStock`
 * guards as an online call (WMS-014.BR02: "server tetap otoritas; hasil offline dapat ditolak") —
 * a scan mismatch, a task someone else already completed, or a cancelled task all surface as
 * `NEEDS_REVIEW` for a supervisor rather than silently dropping (WMS-014.NC02). Idempotent per
 * task: a task already in a terminal status is treated as already-synced rather than re-applied
 * (a device can safely resubmit the same queue after a partial network failure). Every replayed
 * confirmation is audited with `source: 'OFFLINE'` (WMS-014.R02), not the caller's own source.
 */
export async function syncOfflineConfirmations(pool: Pool, raw: SyncOfflineConfirmationsInput): Promise<SyncedOfflineConfirmations> {
  const input = SyncOfflineConfirmationsInputSchema.parse(raw);
  const results: OfflineConfirmationResult[] = [];

  for (const confirmation of input.confirmations) {
    try {
      const task = await pool.query<{ status: string }>(`SELECT status FROM wms.warehouse_task WHERE id = $1`, [confirmation.taskId]);
      const taskRow = task.rows[0];
      if (!taskRow) { results.push({ clientKey: confirmation.clientKey, outcome: 'NEEDS_REVIEW', reason: 'NOT_FOUND' }); continue; }
      if (TERMINAL_STATUSES.has(taskRow.status)) { results.push({ clientKey: confirmation.clientKey, outcome: 'SAVED', reason: null }); continue; }

      if (confirmation.kind === 'PICK') {
        await confirmPickTask(pool, undefined, {
          taskId: confirmation.taskId, scannedLocationCode: confirmation.scannedLocationCode, scannedProductId: confirmation.scannedProductId,
          qtyConfirmed: confirmation.qtyConfirmed, shortReasonCode: confirmation.shortReasonCode,
          actor: input.actor, source: 'OFFLINE',
        });
      } else {
        await putawayStock(pool, undefined, {
          taskId: confirmation.taskId, toLocationCode: confirmation.toLocationCode, qtyConfirmed: confirmation.qtyConfirmed,
          actor: input.actor, source: 'OFFLINE',
        });
      }
      results.push({ clientKey: confirmation.clientKey, outcome: 'SAVED', reason: null });
    } catch (error) {
      const reason = error instanceof DomainError ? error.code : 'UNKNOWN_ERROR';
      results.push({ clientKey: confirmation.clientKey, outcome: 'NEEDS_REVIEW', reason });
    }
  }

  const status = results.every((result) => result.outcome === 'SAVED') ? 'APPLIED' : 'APPLIED_WITH_CONFLICTS';
  return { status, results };
}
