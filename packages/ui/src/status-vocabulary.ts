/**
 * UX-002 status vocabulary registry.
 *
 * This module is the single source of Indonesian status copy (AGENTS.md §5, §18; PRD
 * UX-002, Appendix M). It holds no business rules: it maps a state of a state machine
 * (PRD Appendix E) to a `{label, tone, icon, description}` presentation tuple so that no
 * product ever renders a raw enum (UX-002.NC01, NC02).
 *
 * Provenance and boundaries
 * - Every entry is a verbatim label from PRD Appendix M / M.2, the registry the Product
 *   owner maintains (UX-002 "WRITE AUTHORITY: engineer tidak mengarang label"). Where
 *   Appendix M merges several states into one row, the approved label is split into its
 *   literal components rather than reworded.
 * - Rows that combine several state-machine dimensions, carry a `{placeholder}`, or use
 *   the `external` badge tone are *derived* read-model statuses. They are keyed by the
 *   verbatim Appendix M `aggregateState` and live in `derivedStatusVocabulary`.
 * - `stcCode` values are the aggregate names used by Appendix M and Appendix E, so this
 *   registry joins to the generated PRD catalog without a translation table.
 * - `role` is `'FRONTLINE'` for the PSS Sales/Gudang/Antar wording of Appendix M.1 and
 *   for the PLT-013 sync statuses of Appendix M.2. Product copy that exists only for one
 *   role is stored as a role-specific entry; the unroled entry is the desktop default.
 *
 * GAP-23 (UX-002 "OPEN DECISIONS") is still open: Appendix M has no row for some states
 * that the shipped API can return. `missingStatusVocabularyEntries` lists them so a new
 * state fails CI instead of silently rendering raw.
 */

export const statusTones = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
export type StatusTone = (typeof statusTones)[number];

/** Appendix M also uses `external` for a badge showing the data's source system. */
export const derivedStatusTones = [...statusTones, 'external'] as const;
export type DerivedStatusTone = (typeof derivedStatusTones)[number];

export const frontlineRole = 'FRONTLINE';

export type StatusRegistryKey = {
  readonly stcCode: string;
  readonly state: string;
  readonly role?: string;
};

export type StatusRegistryEntry = {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon: string;
  readonly description: string;
};

/** UX-002.R02: the BFF sends a status object, never a bare state string. */
export type StatusView = StatusRegistryEntry & {
  readonly code: string;
  readonly known: boolean;
};

const entry = (
  stcCode: string,
  state: string,
  label: string,
  tone: StatusTone,
  icon: string,
  description: string,
  role?: string,
): StatusRegistryKey & StatusRegistryEntry => (role ? { stcCode, state, role, label, tone, icon, description } : { stcCode, state, label, tone, icon, description });

/** ICU-style `{name}` slots the caller fills, e.g. "Terlambat 12 hari". */
export type DerivedStatusEntry = {
  readonly labelTemplate: string;
  readonly tone: DerivedStatusTone;
  readonly icon: string;
  readonly description: string;
  readonly placeholders: readonly string[];
};

/**
 * PRD Appendix M.1 and M.2, Product-approved copy only.
 */
export const statusVocabulary: readonly (StatusRegistryKey & StatusRegistryEntry)[] = [
  // --- SalesOrder (STM-SalesOrder) ---------------------------------------------
  entry('SalesOrder', 'DRAFT', 'Draf', 'neutral', 'file-pen', 'Pesanan baru yang belum dikirim.', undefined),
  entry('SalesOrder', 'DRAFT', 'Belum dikirim', 'neutral', 'file-pen', 'Pesanan baru yang belum dikirim.', frontlineRole),
  entry('SalesOrder', 'REQUESTED', 'Diproses', 'info', 'loader', 'Pesanan sedang divalidasi.', undefined),
  entry('SalesOrder', 'REQUESTED', 'Sedang diproses', 'info', 'loader', 'Pesanan sedang divalidasi.', frontlineRole),
  entry('SalesOrder', 'VALIDATED', 'Diproses', 'info', 'loader', 'Pesanan sudah tervalidasi; sedang menunggu stok dan kredit.', undefined),
  entry('SalesOrder', 'VALIDATED', 'Sedang diproses', 'info', 'loader', 'Pesanan sudah tervalidasi dan sedang diproses.', frontlineRole),
  entry('SalesOrder', 'CONFIRMED', 'Siap disiapkan', 'info', 'check', 'Pesanan sudah dikonfirmasi dan masuk ke gudang.', undefined),
  entry('SalesOrder', 'CONFIRMED', 'Diterima', 'info', 'check', 'Pesanan sudah diterima.', frontlineRole),
  entry('SalesOrder', 'IN_FULFILLMENT', 'Sedang dikirim', 'info', 'truck', 'Barang sedang disiapkan dan diantar.', undefined),
  entry('SalesOrder', 'IN_FULFILLMENT', 'Sedang dikirim', 'info', 'truck', 'Barang sedang disiapkan dan diantar.', frontlineRole),
  entry('SalesOrder', 'COMPLETED', 'Selesai', 'success', 'check-circle', 'Seluruh barang sudah dikirim.', undefined),
  entry('SalesOrder', 'COMPLETED', 'Selesai', 'success', 'check-circle', 'Seluruh barang sudah dikirim.', frontlineRole),
  entry('SalesOrder', 'CANCELLED', 'Dibatalkan', 'neutral', 'x-circle', 'Pesanan dibatalkan sebelum diproses.', undefined),
  entry('SalesOrder', 'CANCELLED', 'Batal', 'neutral', 'x-circle', 'Pesanan dibatalkan.', frontlineRole),
  entry('SalesOrder', 'REJECTED', 'Ditolak', 'neutral', 'x-circle', 'Pesanan ditolak saat validasi.', undefined),

  // --- FulfillmentRequest (STM-FulfillmentRequest) --------------------------------
  entry('FulfillmentRequest', 'RELEASED', 'Menunggu disiapkan', 'neutral', 'clock', 'Permintaan persiapan sudah masuk ke gudang.', undefined),

  // --- DeliveryOrder (STM-DeliveryOrder) ------------------------------------------
  entry('DeliveryOrder', 'DISPATCHED', 'Dalam pengiriman', 'info', 'truck', 'Barang sudah keluar dari gudang dan dalam perjalanan.', undefined),
  entry('DeliveryOrder', 'DISPATCHED', 'Dalam perjalanan', 'info', 'truck', 'Barang sedang dalam perjalanan.', frontlineRole),
  entry('DeliveryOrder', 'PARTIALLY_DELIVERED', 'Terkirim sebagian', 'warning', 'package-minus', 'Sebagian barang sudah diterima.', undefined),
  entry('DeliveryOrder', 'PARTIALLY_DELIVERED', 'Sebagian terkirim', 'warning', 'package-minus', 'Sebagian barang sudah diterima.', frontlineRole),
  entry('DeliveryOrder', 'NOT_DELIVERED', 'Gagal kirim', 'danger', 'package-x', 'Barang tidak bisa diserahkan.', undefined),
  entry('DeliveryOrder', 'NOT_DELIVERED', 'Gagal dikirim', 'danger', 'package-x', 'Barang tidak bisa diserahkan.', frontlineRole),

  // --- Invoice (STM-Invoice) --------------------------------------------------------
  entry('Invoice', 'PREPARED', 'Siap kirim (belum jadi tagihan)', 'neutral', 'file-text', 'Nomor tagihan sudah dicadangkan; belum menjadi hutang.'),
  entry('Invoice', 'ISSUED', 'Terbit', 'info', 'receipt', 'Tagihan sudah terbit menjadi hutang.'),

  // --- Receivable (STM-Receivable) --------------------------------------------------
  entry('Receivable', 'NOT_DUE', 'Belum jatuh tempo', 'neutral', 'calendar', 'Tanggal jatuh tempo belum tiba.', undefined),
  entry('Receivable', 'NOT_DUE', 'Belum jatuh tempo', 'neutral', 'calendar', 'Jatuh tempo belum tiba.', frontlineRole),
  entry('Receivable', 'DUE', 'Jatuh tempo hari ini', 'warning', 'calendar-clock', 'Tagihan jatuh tempo hari ini.', undefined),
  entry('Receivable', 'DUE', 'Tagih hari ini', 'warning', 'calendar-clock', 'Tagihan jatuh tempo hari ini.', frontlineRole),
  entry('Receivable', 'SETTLED', 'Lunas', 'success', 'badge-check', 'Tidak ada sisa tagihan.', undefined),
  entry('Receivable', 'SETTLED', 'Lunas', 'success', 'badge-check', 'Tidak ada sisa tagihan.', frontlineRole),
  entry('Receivable', 'DISPUTED', 'Dalam sengketa', 'warning', 'message-circle-warning', 'Ada sengketa yang sedang diperiksa.', undefined),
  entry('Receivable', 'DISPUTED', 'Sedang dicek kantor', 'warning', 'message-circle-warning', 'Sengketa sedang diperiksa kantor.', frontlineRole),

  // --- Payment (STM-Payment) ---------------------------------------------------------
  entry('Payment', 'PENDING_VERIFICATION', 'Perlu dicek', 'warning', 'hourglass', 'Pembayaran menunggu pencocokan.', undefined),
  entry('Payment', 'PENDING_VERIFICATION', 'Menunggu dicek kasir', 'warning', 'hourglass', 'Pembayaran menunggu pencocokan.', frontlineRole),
  entry('Payment', 'REJECTED', 'Ditolak', 'danger', 'ban', 'Pembayaran ditolak karena dana tidak ditemukan.', undefined),
  entry('Payment', 'REJECTED', 'Perlu dicek', 'danger', 'ban', 'Pembayaran ditolak; perlu diperiksa lagi.', frontlineRole),
  entry('Payment', 'BOUNCED', 'Giro tolak', 'danger', 'ban', 'Giro atau cek ditolak bank.', undefined),
  entry('Payment', 'BOUNCED', 'Perlu dicek', 'danger', 'ban', 'Giro ditolak bank.', frontlineRole),

  // --- CashCustody (STM-CashCustodyRecord) --------------------------------------------
  entry('CashCustody', 'DISCREPANCY', 'Ada selisih', 'danger', 'scale', 'Hitungan kas tidak sama dengan deklarasi.', undefined),
  entry('CashCustody', 'DISCREPANCY', 'Ada selisih — hubungi kasir', 'danger', 'scale', 'Ada selisih kas; hubungi kasir.', frontlineRole),

  // --- WarehouseTask (STM SFA, WMS, Fleet, Geo) ---------------------------------------
  entry('WarehouseTask', 'ASSIGNED', 'Tugas baru', 'info', 'list-todo', 'Tugas sudah ditugaskan tetapi belum dikerjakan.', undefined),
  entry('WarehouseTask', 'ASSIGNED', 'Tugas baru', 'info', 'list-todo', 'Tugas baru menunggu dikerjakan.', frontlineRole),
  entry('WarehouseTask', 'COMPLETED_SHORT', 'Selesai, barang kurang', 'warning', 'package-minus', 'Tugas selesai tetapi jumlahnya kurang.', undefined),
  entry('WarehouseTask', 'COMPLETED_SHORT', 'Barang kurang dilaporkan', 'warning', 'package-minus', 'Barang kurang sudah dilaporkan.', frontlineRole),

  // --- DeliveryAttempt (STM SFA, WMS, Fleet, Geo) ---------------------------------------
  entry('DeliveryAttempt', 'PENDING', 'Belum dikunjungi', 'neutral', 'map-pin', 'Kunjungan belum dimulai.', frontlineRole),
  entry('DeliveryAttempt', 'ARRIVED', 'Sudah sampai', 'info', 'map-pin-check', 'Telah sampai di lokasi.', frontlineRole),

  // --- ProofOfDelivery (STM SFA, WMS, Fleet, Geo) --------------------------------------
  entry('ProofOfDelivery', 'MISSING', 'Bukti kirim belum ada', 'danger', 'camera-off', 'Bukti penerimaan belum lengkap.', undefined),
  entry('ProofOfDelivery', 'MISSING', 'Foto bukti belum ada', 'danger', 'camera-off', 'Foto bukti penerimaan belum ada.', frontlineRole),

  // --- Journal (STM-Journal) -------------------------------------------------------------
  entry('Journal', 'SUBMITTED', 'Menunggu persetujuan', 'warning', 'stamp', 'Jurnal sudah diajukan dan menunggu persetujuan.'),
  entry('Journal', 'POSTED', 'Diposting', 'success', 'book-check', 'Jurnal sudah masuk buku besar.'),

  // --- AccountingPeriod (STM-AccountingPeriod) --------------------------------------------
  entry('AccountingPeriod', 'SOFT_CLOSE', 'Sedang tutup buku', 'warning', 'lock-open', 'Periode sedang ditutup; masih ada toleransi penyesuaian.'),
  entry('AccountingPeriod', 'CLOSED', 'Terkunci', 'neutral', 'lock', 'Periode sudah tertutup dan tidak menerima jurnal.'),

  // --- StagingRecord (STM Integration) --------------------------------------------------------
  entry('StagingRecord', 'PENDING_MAPPING', 'Data belum dikenali', 'warning', 'help-circle', 'Baris impor menunggu pemetaan ke data master.'),
  entry('StagingRecord', 'REJECTED', 'Data tidak valid', 'danger', 'file-warning', 'Baris impor ditolak karena tidak valid.'),

  // --- SyncBatch (STM Integration) -------------------------------------------------------------
  entry('SyncBatch', 'FAILED', 'Sinkronisasi gagal', 'danger', 'cloud-off', 'Batch sinkronisasi gagal dan menunggu diproses ulang.'),

  // --- OrderRequest (STM SFA, WMS, Fleet, Geo) ---------------------------------------------------
  entry('OrderRequest', 'QUEUED', 'Menunggu Sinkronisasi', 'info', 'refresh-cw', 'Pesanan tersimpan di perangkat dan belum terkirim.', frontlineRole),
  entry('OrderRequest', 'ACCEPTED', 'Tersimpan', 'success', 'check', 'Pesanan sudah diterima server.', frontlineRole),
  entry('OrderRequest', 'NEEDS_ATTENTION', 'Perlu Diperiksa', 'warning', 'alert-triangle', 'Pesanan perlu diperiksa petugas.', frontlineRole),

  // --- Visit (STM SFA, WMS, Fleet, Geo) -----------------------------------------------------------
  entry('Visit', 'SKIPPED', 'Dilewati', 'neutral', 'skip-forward', 'Kunjungan dilewati.', undefined),
  entry('Visit', 'SKIPPED', 'Dilewati', 'neutral', 'skip-forward', 'Kunjungan dilewati.', frontlineRole),

  // --- Outlet location (LocationCapture, STM SFA, WMS, Fleet, Geo) ---------------------------------
  entry('OutletLocation', 'UNMAPPED', 'Lokasi belum direkam', 'warning', 'map-pin-off', 'Lokasi toko belum direkam.', undefined),
  entry('OutletLocation', 'UNMAPPED', 'Rekam lokasi', 'warning', 'map-pin-off', 'Lokasi toko belum direkam.', frontlineRole),

  // --- PosShift (POS §46A) -----------------------------------------------------------------------
  entry('PosShift', 'OPEN', 'Shift berjalan', 'info', 'play-circle', 'Shift kasir sedang berjalan.'),
  entry('PosShift', 'CLOSED', 'Shift ditutup', 'success', 'check-circle', 'Shift kasir sudah ditutup.'),
  entry('PosShift', 'CLOSED_WITH_DISCREPANCY', 'Ada selisih kas', 'danger', 'scale', 'Shift ditutup dengan selisih kas.'),
  entry('PosShift', 'HANDED_OVER', 'Kas sudah diserahkan', 'success', 'badge-check', 'Kas shift sudah diserahkan.'),

  // --- PosSale (POS §46A) -----------------------------------------------------------------------
  entry('PosSale', 'CART', 'Keranjang', 'neutral', 'shopping-cart', 'Keranjang masih diisi.'),
  entry('PosSale', 'PENDING_PAYMENT', 'Menunggu bayar', 'warning', 'hourglass', 'Transaksi menunggu pembayaran.'),
  entry('PosSale', 'PAID', 'Lunas', 'success', 'check-circle', 'Transaksi sudah lunas.'),
  entry('PosSale', 'CREDIT_APPROVED', 'Tempo disetujui', 'info', 'receipt', 'Penjualan kredit sudah disetujui.'),
  entry('PosSale', 'HANDED_OVER', 'Barang sudah diambil', 'success', 'package-check', 'Barang sudah diambil pelanggan.'),
  entry('PosSale', 'CANCELLED', 'Dibatalkan', 'neutral', 'x-circle', 'Transaksi dibatalkan.'),

  // --- PosTender (POS §46A) ----------------------------------------------------------------------
  entry('PosTender', 'PENDING_CONFIRMATION', 'Menunggu dana masuk', 'warning', 'clock', 'Pembayaran nontunai masih menunggu dana masuk.'),
  entry('PosTender', 'VOIDED', 'Dibatalkan', 'neutral', 'ban', 'Pembayaran dibatalkan.'),

  // --- Sync status (Appendix M.2, PLT-013) --------------------------------------------------------
  entry('Sync', 'SAVED', 'Tersimpan', 'success', 'check', 'Pekerjaan tersimpan di perangkat.', frontlineRole),
  entry('Sync', 'PENDING_SYNC', 'Menunggu Sinkronisasi', 'info', 'cloud-upload', 'Pekerjaan tersimpan dan menunggu dikirim.', frontlineRole),
  entry('Sync', 'NEEDS_REVIEW', 'Perlu Diperiksa', 'warning', 'alert-triangle', 'Pekerjaan perlu diperiksa petugas.', frontlineRole),
];

/**
 * PRD Appendix M rows that are not a single state of a state machine: a composite of
 * several dimensions, a derived (◇) status, or the `external` badge tone. A BFF resolves
 * these after collapsing the dimensions, per Appendix M's priority order.
 */
export const derivedStatusVocabulary: Readonly<Record<string, DerivedStatusEntry>> = {
  'SalesOrder · VALIDATED + CreditDecision ON_HOLD': {
    labelTemplate: 'Menunggu persetujuan kredit',
    tone: 'warning',
    icon: 'shield-alert',
    description: 'Kredit belum terpenuhi sehingga perlu persetujuan.',
    placeholders: [],
  },
  'SalesOrder · VALIDATED + CreditDecision ON_HOLD@FRONTLINE': {
    labelTemplate: 'Perlu persetujuan kredit',
    tone: 'warning',
    icon: 'shield-alert',
    description: 'Kredit belum terpenuhi sehingga perlu persetujuan.',
    placeholders: [],
  },
  'SalesOrder · VALIDATED + reservasi PARTIAL/NONE': {
    labelTemplate: 'Sebagian barang belum tersedia',
    tone: 'warning',
    icon: 'package-x',
    description: 'Sebagian atau seluruh barang belum tersedia.',
    placeholders: [],
  },
  'SalesOrder · VALIDATED + reservasi PARTIAL/NONE@FRONTLINE': {
    labelTemplate: 'Barang belum lengkap',
    tone: 'warning',
    icon: 'package-x',
    description: 'Sebagian atau seluruh barang belum tersedia.',
    placeholders: [],
  },
  'SalesOrder · VALIDATED (observed)': {
    labelTemplate: 'Tercatat dari {sumber}',
    tone: 'external',
    icon: 'link',
    description: 'Pesanan berasal dari sistem lain dan tidak dikonfirmasi PSS.',
    placeholders: ['sumber'],
  },
  'Payment · VERIFIED + UNAPPLIED/PARTIALLY': {
    labelTemplate: 'Belum dialokasikan',
    tone: 'warning',
    icon: 'split',
    description: 'Pembayaran sudah terverifikasi tetapi belum dialokasikan ke tagihan.',
    placeholders: [],
  },
  'Payment · VERIFIED + FULLY_APPLIED': {
    labelTemplate: 'Sudah dialokasikan',
    tone: 'success',
    icon: 'check-circle',
    description: 'Pembayaran sudah dialokasikan sepenuhnya.',
    placeholders: [],
  },
  'Payment · VERIFIED + FULLY_APPLIED@FRONTLINE': {
    labelTemplate: 'Diterima kantor',
    tone: 'success',
    icon: 'check-circle',
    description: 'Pembayaran sudah diterima kantor.',
    placeholders: [],
  },
  'Receivable · OVERDUE_*': {
    labelTemplate: 'Terlambat {n} hari',
    tone: 'danger',
    icon: 'alarm-clock',
    description: 'Tagihan sudah lewat jatuh tempo.',
    placeholders: ['n'],
  },
  'Cash · belum disetor': {
    labelTemplate: 'Kas belum disetor',
    tone: 'warning',
    icon: 'wallet',
    description: 'Uang tunai belum disetor ke bank.',
    placeholders: [],
  },
  'Cash · belum disetor@FRONTLINE': {
    labelTemplate: 'Uang di tangan',
    tone: 'warning',
    icon: 'wallet',
    description: 'Uang tunai masih di tangan.',
    placeholders: [],
  },
};

/** UX-002.E2 runtime fallback. The raw state is never shown or logged as a label. */
export const unknownStatusEntry: StatusRegistryEntry = {
  label: 'Status tidak dikenal',
  tone: 'neutral',
  icon: 'circle-help',
  description: 'Muat ulang halaman. Bila masih muncul, hubungi admin.',
};

export const unknownStatusActionLabel = 'Muat Ulang';

const byKey = new Map<string, StatusRegistryKey & StatusRegistryEntry>(
  statusVocabulary.map((row) => [`${row.stcCode}|${row.state}|${row.role ?? ''}`, row]),
);

function derivedKey(aggregateState: string, role?: string): string {
  return role ? `${aggregateState}@${role}` : aggregateState;
}

function hasStatusEntry(stcCode: string, state: string, role?: string): boolean {
  if (byKey.has(`${stcCode}|${state}|${role ?? ''}`)) return true;
  // A state whose only approved copy is role-specific (Appendix M.2's frontline-only sync
  // statuses) is still covered: it has a label wherever it is allowed to appear.
  if (role) return false;
  for (const row of statusVocabulary) {
    if (row.stcCode === stcCode && row.state === state) return true;
  }
  return false;
}

export function findStatusEntry(key: StatusRegistryKey): (StatusRegistryKey & StatusRegistryEntry) | undefined {
  return byKey.get(`${key.stcCode}|${key.state}|${key.role ?? ''}`);
}

export function findDerivedStatusEntry(
  aggregateState: string,
  role?: string,
): DerivedStatusEntry | undefined {
  return derivedStatusVocabulary[derivedKey(aggregateState, role)] ?? derivedStatusVocabulary[aggregateState];
}

/**
 * UX-002.AC04: a role-specific label wins, the unroled entry is the desktop default, and
 * an unknown state returns the fallback without leaking the raw code (UX-002.E2).
 */
export function resolveStatus(key: StatusRegistryKey): StatusView {
  const found = findStatusEntry(key) ?? (key.role ? findStatusEntry({ stcCode: key.stcCode, state: key.state }) : undefined);
  if (!found) {
    return { code: key.state, ...unknownStatusEntry, known: false };
  }
  return { code: found.state, label: found.label, tone: found.tone, icon: found.icon, description: found.description, known: true };
}

/** Fill `{n}` / `{sumber}` slots with values the caller already computed. */
export function fillDerivedStatusLabel(entryValue: DerivedStatusEntry, values: Readonly<Record<string, string | number>>): string {
  return entryValue.labelTemplate.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

export type MissingStatusEntry = { stcCode: string; state: string };
export type PendingStatusLabel = MissingStatusEntry & { readonly reason: string };

/**
 * States the shipped API can return that PRD Appendix M does not yet cover.
 *
 * UX-002 assigns label copy to Product/Ops ("engineer tidak mengarang label",
 * AGT §18), and GAP-23 is still open, so these are acknowledged rather than invented.
 * Each entry is an explicit decision: a new contract state that is neither registered
 * nor listed here fails `pnpm ui:check`, so the gap cannot grow unnoticed.
 */
export const pendingStatusLabels: readonly PendingStatusLabel[] = [
  { stcCode: 'PosTender', state: 'ACCEPTED', reason: 'Appendix M registers only PENDING_CONFIRMATION and VOIDED.' },
  { stcCode: 'PosTerminal', state: 'ACTIVE', reason: 'Terminal state has no Appendix M row; GAP-23.' },
  { stcCode: 'PosTerminal', state: 'INACTIVE', reason: 'Terminal state has no Appendix M row; GAP-23.' },
  { stcCode: 'KasirCatalogItem', state: 'DRAFT', reason: 'Catalog item state has no Appendix M row; GAP-23.' },
  { stcCode: 'KasirCatalogItem', state: 'ACTIVE', reason: 'Catalog item state has no Appendix M row; GAP-23.' },
  { stcCode: 'KasirCatalogItem', state: 'INACTIVE', reason: 'Catalog item state has no Appendix M row; GAP-23.' },
  { stcCode: 'PosOfflineBatch', state: 'APPLIED', reason: 'Sync batch result, not a document state; PLT-013 restricts frontline to three statuses.' },
  { stcCode: 'PosOfflineBatch', state: 'APPLIED_WITH_CONFLICTS', reason: 'Sync batch result, not a document state; GAP-23.' },
  { stcCode: 'WmsOfflineSync', state: 'APPLIED', reason: 'Sync batch result, not a document state; PLT-013 restricts frontline to three statuses.' },
  { stcCode: 'WmsOfflineSync', state: 'APPLIED_WITH_CONFLICTS', reason: 'Sync batch result, not a document state; GAP-23.' },
  { stcCode: 'WarehouseTask', state: 'CREATED', reason: 'Appendix M covers ASSIGNED and COMPLETED_SHORT only; GAP-23.' },
  { stcCode: 'WarehouseTask', state: 'IN_PROGRESS', reason: 'Appendix M covers ASSIGNED and COMPLETED_SHORT only; GAP-23.' },
  { stcCode: 'WarehouseTask', state: 'COMPLETED', reason: 'Appendix M covers ASSIGNED and COMPLETED_SHORT only; GAP-23.' },
  { stcCode: 'WarehouseTask', state: 'CANCELLED', reason: 'Appendix M covers ASSIGNED and COMPLETED_SHORT only; GAP-23.' },
  { stcCode: 'WarehouseLocation', state: 'ACTIVE', reason: 'Location state is not a user-facing document status; GAP-23.' },
  { stcCode: 'WarehouseLocation', state: 'BLOCKED', reason: 'Location state is not a user-facing document status; GAP-23.' },
  { stcCode: 'StockDiscrepancy', state: 'REPORTED', reason: 'Appendix M has no StockDiscrepancy row; GAP-23.' },
  { stcCode: 'StockDiscrepancy', state: 'ADJUSTED', reason: 'Appendix M has no StockDiscrepancy row; GAP-23.' },
  { stcCode: 'StockDiscrepancy', state: 'REJECTED', reason: 'Appendix M has no StockDiscrepancy row; GAP-23.' },
  { stcCode: 'ExceptionItem', state: 'OPEN', reason: 'Appendix P labels queues, not per-item states; GAP-23.' },
  { stcCode: 'ExceptionItem', state: 'IN_PROGRESS', reason: 'Appendix P labels queues, not per-item states; GAP-23.' },
  { stcCode: 'ExceptionItem', state: 'RESOLVED', reason: 'Appendix P labels queues, not per-item states; GAP-23.' },
];

function isPendingStatusLabel(stcCode: string, state: string): boolean {
  return pendingStatusLabels.some((row) => row.stcCode === stcCode && row.state === state);
}

/**
 * UX-002.AC01 completeness check. Every state of every state machine the shipped contracts
 * expose must have a registry entry or an explicit `pendingStatusLabels` acknowledgement;
 * anything else is a UX-002.E1 CI failure.
 */
export function missingStatusVocabularyEntries(
  stateUnions: readonly { stcCode: string; states: readonly string[] }[],
): MissingStatusEntry[] {
  return stateUnions.flatMap(({ stcCode, states }) => states
    .filter((state) => !hasStatusEntry(stcCode, state) && !isPendingStatusLabel(stcCode, state))
    .map((state) => ({ stcCode, state })));
}
