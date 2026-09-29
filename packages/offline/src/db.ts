import Dexie, { type EntityTable } from 'dexie';

export interface CachedCatalogEntry {
  productId: string;
  sku: string;
  name: string;
  uom: string;
  barcode?: string;
  unitPrice: string;
  priceListVersion: number;
  cachedAt: string;
}

export type QueuedOfflineSaleStatus = 'PENDING' | 'SYNCING' | 'SAVED' | 'NEEDS_REVIEW';

export interface QueuedOfflineSaleLine {
  productId: string;
  uom: string;
  sku: string;
  name: string;
  qty: string;
}

export interface QueuedOfflineSale {
  offlineSaleId: string;
  number: string;
  customerId: string | null;
  lines: QueuedOfflineSaleLine[];
  cashReceived: string;
  deviceTime: string;
  status: QueuedOfflineSaleStatus;
  posSaleId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface CachedShiftState {
  terminalId: string;
  shiftId: string;
  offlineNumberBlockStart: number;
  offlineNumberBlockEnd: number;
  offlineNumberNext: number;
}

/**
 * Per-terminal offline store (POS-013). Each browser tab/device gets its own IndexedDB
 * database — never shared across viewers — matching the artifact/browser-storage privacy
 * model this platform otherwise avoids relying on for anything durable server-side.
 */
export class PosOfflineDatabase extends Dexie {
  catalog!: EntityTable<CachedCatalogEntry, 'productId'>;
  queuedSales!: EntityTable<QueuedOfflineSale, 'offlineSaleId'>;
  shiftState!: EntityTable<CachedShiftState, 'terminalId'>;

  constructor(name = 'pss-pos-offline') {
    super(name);
    this.version(1).stores({
      catalog: 'productId, barcode, sku',
      queuedSales: 'offlineSaleId, status, createdAt',
      shiftState: 'terminalId',
    });
  }
}

let singleton: PosOfflineDatabase | undefined;

/** One database per browser context; call once and reuse (Dexie itself is safe to keep open). */
export function openPosOfflineDatabase(): PosOfflineDatabase {
  singleton ??= new PosOfflineDatabase();
  return singleton;
}
