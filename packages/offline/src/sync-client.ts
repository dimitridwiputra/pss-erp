import type { PosOfflineDatabase, QueuedOfflineSale } from './db';
import { applyOfflineSaleResults, listPendingOfflineSales, markOfflineSalesSyncing, type OfflineSaleSyncResult } from './pos-offline-queue';

export interface SyncPosOfflineBatchWireResponse {
  batchId: string;
  status: 'APPLIED' | 'APPLIED_WITH_CONFLICTS';
  results: OfflineSaleSyncResult[];
}

export interface SyncPosOfflineBatchOptions {
  terminalId: string;
  endpoint: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * POS-013 `SyncPosOfflineBatch`: sends every PENDING sale in one request (server applies each
 * transaction's own checkout+tender steps and returns a per-sale outcome — `SAVED` or
 * `NEEDS_REVIEW`, the only two states the UI is allowed to show per Appendix M.2 / UX-000.R14).
 * Safe to call repeatedly — a batch that partially failed leaves unresolved sales `PENDING`
 * again for the next attempt (nothing is marked `SYNCING` past this call's own lifetime).
 */
export async function syncPosOfflineBatch(db: PosOfflineDatabase, options: SyncPosOfflineBatchOptions): Promise<SyncPosOfflineBatchWireResponse | null> {
  const pending = await listPendingOfflineSales(db);
  if (pending.length === 0) return null;
  const doFetch = options.fetchImpl ?? fetch;
  await markOfflineSalesSyncing(db, pending.map((sale) => sale.offlineSaleId));
  try {
    const response = await doFetch(options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': options.idempotencyKey },
      body: JSON.stringify({ terminalId: options.terminalId, sales: pending.map(toWireSale) }),
    });
    if (!response.ok) throw new Error(`Sync request failed with status ${response.status}`);
    const body = (await response.json()) as SyncPosOfflineBatchWireResponse;
    await applyOfflineSaleResults(db, body.results);
    return body;
  } catch (error) {
    // Leave the batch PENDING again so the next connectivity window retries it (PP-09: nothing silently drops).
    await db.queuedSales.where('offlineSaleId').anyOf(pending.map((sale) => sale.offlineSaleId)).modify({ status: 'PENDING' });
    throw error;
  }
}

function toWireSale(sale: QueuedOfflineSale) {
  return {
    offlineSaleId: sale.offlineSaleId,
    number: sale.number,
    customerId: sale.customerId,
    lines: sale.lines,
    cashReceived: sale.cashReceived,
    deviceTime: sale.deviceTime,
  };
}
