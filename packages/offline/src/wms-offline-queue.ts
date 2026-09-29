import type { QueuedWmsConfirmation, QueuedWmsConfirmationPayload, WmsOfflineDatabase } from './wms-offline-db';

/** Generates a client-side idempotency key (WMS-014.R01) and stores the confirmation locally as PENDING. */
export async function enqueueOfflineConfirmation(db: WmsOfflineDatabase, taskId: string, payload: QueuedWmsConfirmationPayload): Promise<QueuedWmsConfirmation> {
  const record: QueuedWmsConfirmation = {
    clientKey: crypto.randomUUID(),
    taskId,
    payload,
    status: 'PENDING',
    reason: null,
    createdAt: new Date().toISOString(),
  };
  await db.queuedConfirmations.add(record);
  return record;
}

export async function listPendingOfflineConfirmations(db: WmsOfflineDatabase): Promise<QueuedWmsConfirmation[]> {
  return db.queuedConfirmations.where('status').equals('PENDING').sortBy('createdAt');
}

export async function countPendingOfflineConfirmations(db: WmsOfflineDatabase): Promise<number> {
  return db.queuedConfirmations.where('status').equals('PENDING').count();
}

export async function markOfflineConfirmationsSyncing(db: WmsOfflineDatabase, clientKeys: string[]): Promise<void> {
  await db.queuedConfirmations.where('clientKey').anyOf(clientKeys).modify({ status: 'SYNCING' });
}

export interface WmsOfflineConfirmationResult {
  clientKey: string;
  outcome: 'SAVED' | 'NEEDS_REVIEW';
  reason: string | null;
}

export async function applyOfflineConfirmationResults(db: WmsOfflineDatabase, results: WmsOfflineConfirmationResult[]): Promise<void> {
  await db.transaction('rw', db.queuedConfirmations, async () => {
    for (const result of results) {
      await db.queuedConfirmations.update(result.clientKey, { status: result.outcome, reason: result.reason });
    }
  });
}
