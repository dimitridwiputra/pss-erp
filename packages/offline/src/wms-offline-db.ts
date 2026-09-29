import Dexie, { type EntityTable } from 'dexie';

export type QueuedWmsConfirmationStatus = 'PENDING' | 'SYNCING' | 'SAVED' | 'NEEDS_REVIEW';

export interface QueuedPickConfirmationPayload {
  kind: 'PICK';
  scannedLocationCode: string;
  scannedProductId: string;
  qtyConfirmed: string;
  shortReasonCode?: string;
}

export interface QueuedPutawayConfirmationPayload {
  kind: 'PUTAWAY';
  toLocationCode: string;
  qtyConfirmed: string;
}

export type QueuedWmsConfirmationPayload = QueuedPickConfirmationPayload | QueuedPutawayConfirmationPayload;

export interface QueuedWmsConfirmation {
  clientKey: string;
  taskId: string;
  payload: QueuedWmsConfirmationPayload;
  status: QueuedWmsConfirmationStatus;
  reason: string | null;
  createdAt: string;
}

/**
 * WMS-014: a handheld device's queue of PICK/PUTAWAY confirmations made while offline. One
 * database per browser context, same convention as `PosOfflineDatabase` (never shared across
 * viewers, nothing durable server-side depends on it surviving).
 */
export class WmsOfflineDatabase extends Dexie {
  queuedConfirmations!: EntityTable<QueuedWmsConfirmation, 'clientKey'>;

  constructor(name = 'pss-wms-offline') {
    super(name);
    this.version(1).stores({
      queuedConfirmations: 'clientKey, status, createdAt',
    });
  }
}

let singleton: WmsOfflineDatabase | undefined;

export function openWmsOfflineDatabase(): WmsOfflineDatabase {
  singleton ??= new WmsOfflineDatabase();
  return singleton;
}
