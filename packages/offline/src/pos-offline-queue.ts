import type { PosOfflineDatabase, QueuedOfflineSale, QueuedOfflineSaleLine } from './db';

export interface EnqueueOfflineSaleInput {
  number: string;
  customerId: string | null;
  lines: QueuedOfflineSaleLine[];
  cashReceived: string;
}

/** Generates a client-side idempotency key (POS-013.R01) and stores the sale locally as PENDING. */
export async function enqueueOfflineSale(db: PosOfflineDatabase, input: EnqueueOfflineSaleInput): Promise<QueuedOfflineSale> {
  const record: QueuedOfflineSale = {
    offlineSaleId: crypto.randomUUID(),
    number: input.number,
    customerId: input.customerId,
    lines: input.lines,
    cashReceived: input.cashReceived,
    deviceTime: new Date().toISOString(),
    status: 'PENDING',
    posSaleId: null,
    reason: null,
    createdAt: new Date().toISOString(),
  };
  await db.queuedSales.add(record);
  return record;
}

export async function listPendingOfflineSales(db: PosOfflineDatabase): Promise<QueuedOfflineSale[]> {
  return db.queuedSales.where('status').equals('PENDING').toArray();
}

export async function countPendingOfflineSales(db: PosOfflineDatabase): Promise<number> {
  return db.queuedSales.where('status').equals('PENDING').count();
}

export async function markOfflineSalesSyncing(db: PosOfflineDatabase, offlineSaleIds: string[]): Promise<void> {
  await db.queuedSales.where('offlineSaleId').anyOf(offlineSaleIds).modify({ status: 'SYNCING' });
}

export interface OfflineSaleSyncResult {
  offlineSaleId: string;
  outcome: 'SAVED' | 'NEEDS_REVIEW';
  posSaleId: string | null;
  reason: string | null;
}

export async function applyOfflineSaleResults(db: PosOfflineDatabase, results: OfflineSaleSyncResult[]): Promise<void> {
  await db.transaction('rw', db.queuedSales, async () => {
    for (const result of results) {
      await db.queuedSales.update(result.offlineSaleId, {
        status: result.outcome, posSaleId: result.posSaleId, reason: result.reason,
      });
    }
  });
}
