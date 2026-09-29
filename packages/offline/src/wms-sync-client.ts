import type { QueuedWmsConfirmation, WmsOfflineDatabase } from './wms-offline-db';
import {
  applyOfflineConfirmationResults, listPendingOfflineConfirmations, markOfflineConfirmationsSyncing,
  type WmsOfflineConfirmationResult,
} from './wms-offline-queue';

export interface SyncWmsOfflineBatchWireResponse {
  status: 'APPLIED' | 'APPLIED_WITH_CONFLICTS';
  results: WmsOfflineConfirmationResult[];
}

export interface SyncWmsOfflineBatchOptions {
  endpoint: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * WMS-014 `/gudang/sync`: sends every PENDING queued confirmation in one request — the server
 * replays each through the normal `confirmPickTask`/`putawayStock` guards and returns a per-item
 * outcome (`SAVED` or `NEEDS_REVIEW`), the same two states POS's offline sync surfaces (Appendix
 * M.2 / UX-000.R14). Safe to call repeatedly: a batch that fails outright (network error) leaves
 * every item `PENDING` again for the next attempt rather than losing it (PP-09).
 */
export async function syncWmsOfflineBatch(db: WmsOfflineDatabase, options: SyncWmsOfflineBatchOptions): Promise<SyncWmsOfflineBatchWireResponse | null> {
  const pending = await listPendingOfflineConfirmations(db);
  if (pending.length === 0) return null;
  const doFetch = options.fetchImpl ?? fetch;
  await markOfflineConfirmationsSyncing(db, pending.map((confirmation) => confirmation.clientKey));
  try {
    const response = await doFetch(options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': options.idempotencyKey },
      body: JSON.stringify({ confirmations: pending.map(toWireConfirmation) }),
    });
    if (!response.ok) throw new Error(`Sync request failed with status ${response.status}`);
    const body = (await response.json()) as SyncWmsOfflineBatchWireResponse;
    await applyOfflineConfirmationResults(db, body.results);
    return body;
  } catch (error) {
    await db.queuedConfirmations.where('clientKey').anyOf(pending.map((confirmation) => confirmation.clientKey)).modify({ status: 'PENDING' });
    throw error;
  }
}

function toWireConfirmation(confirmation: QueuedWmsConfirmation) {
  return { clientKey: confirmation.clientKey, taskId: confirmation.taskId, ...confirmation.payload };
}
