/**
 * Every web work screen, in one list: the app shell's sidebar, the quick-jump and the Beranda tiles
 * all read it. A screen is shown only to someone holding its permission somewhere (DESIGN_SYSTEM
 * §7.2: absent, never disabled); the screen and the API still check scope on every record.
 *
 * Append-only for the other streams (MVP_PLAN §4 hotspot): add one entry when your route exists.
 * `section` groups the sidebar by work, not by domain (DESIGN_SYSTEM §7.1). `icon` names an entry
 * in `app/_shell/icons.tsx`. `tile: false` keeps a screen out of the Beranda tiles.
 */
export const workSections = [
  { key: 'hari-ini', label: 'Hari Ini' },
  { key: 'penjualan', label: 'Penjualan' },
  { key: 'kas', label: 'Kas' },
  { key: 'persediaan', label: 'Persediaan' },
  { key: 'data-utama', label: 'Data Utama' },
  { key: 'keuangan', label: 'Keuangan' },
  { key: 'laporan', label: 'Laporan' },
] as const;

export type WorkSectionKey = (typeof workSections)[number]['key'];

export interface WorkScreen {
  key: string;
  label: string;
  description: string;
  href: string;
  /** A concrete Appendix D permission code, never a role (RBAC-001.R02). `null`: every signed-in user. */
  permission: string | null;
  section: WorkSectionKey;
  icon: string;
  tile?: boolean;
}

export const workScreens: readonly WorkScreen[] = [
  { key: 'beranda', label: 'Beranda', description: 'Ringkasan hari ini dan pekerjaan Anda.', href: '/beranda', permission: null, section: 'hari-ini', icon: 'home', tile: false },
  { key: 'kasir', label: 'Kasir', description: 'Buka shift dan layani pembeli di konter.', href: '/kasir', permission: 'pos.shift.open', section: 'penjualan', icon: 'kasir' },
  { key: 'serah-barang', label: 'Serah Barang', description: 'Serahkan barang yang sudah dibayar di konter.', href: '/kasir', permission: 'fulfillment.pickup.handover', section: 'penjualan', icon: 'serah-barang' },
  { key: 'penjualan', label: 'Penjualan Konter', description: 'Lihat transaksi kasir dan fakturnya.', href: '/kantor/penjualan', permission: 'pos.report.view', section: 'penjualan', icon: 'penjualan' },
  { key: 'setoran-kas', label: 'Setoran Kas', description: 'Hitung dan terima uang dari kasir.', href: '/kantor/setoran-kas', permission: 'payments.cash_custody.verify', section: 'kas', icon: 'setoran-kas' },
  { key: 'dasbor-kantor', label: 'Dasbor Harian', description: 'Penjualan, kas, dan stok hari ini.', href: '/kantor', permission: 'pos.report.view', section: 'hari-ini', icon: 'dasbor' },
  { key: 'barang', label: 'Barang', description: 'Daftar barang, satuan, dan barcode.', href: '/kantor/barang', permission: 'master_data.product.manage', section: 'data-utama', icon: 'barang' },
  { key: 'harga', label: 'Harga Jual', description: 'Harga konter per satuan.', href: '/kantor/harga', permission: 'commercial.price_list.manage', section: 'data-utama', icon: 'harga' },
  { key: 'pelanggan', label: 'Pelanggan', description: 'Daftar pelanggan.', href: '/kantor/pelanggan', permission: 'master_data.product.manage', section: 'data-utama', icon: 'pelanggan', tile: false },
  { key: 'stok', label: 'Stok', description: 'Saldo dan nilai stok per gudang.', href: '/kantor/stok', permission: 'inventory.stock_card.view', section: 'persediaan', icon: 'stok' },
  { key: 'terima', label: 'Terima Barang', description: 'Catat barang masuk beserta harga pokoknya.', href: '/kantor/terima', permission: 'procurement.receipt.post', section: 'persediaan', icon: 'terima' },
  { key: 'penyesuaian', label: 'Penyesuaian Stok', description: 'Koreksi stok dengan alasan.', href: '/kantor/penyesuaian', permission: 'inventory.adjustment.request', section: 'persediaan', icon: 'penyesuaian', tile: false },
  { key: 'keuangan', label: 'Ringkasan Keuangan', description: 'Tinjau jurnal, laporan, dan periode akuntansi.', href: '/keuangan', permission: 'finance.journal.create', section: 'keuangan', icon: 'dasbor' },
  { key: 'jurnal', label: 'Jurnal', description: 'Jurnal otomatis dan manual.', href: '/keuangan/jurnal', permission: 'finance.journal.create', section: 'keuangan', icon: 'jurnal', tile: false },
  { key: 'jurnal-manual', label: 'Jurnal Manual', description: 'Buat jurnal penyesuaian.', href: '/keuangan/jurnal-manual', permission: 'finance.journal.create', section: 'keuangan', icon: 'jurnal', tile: false },
  { key: 'buku-besar', label: 'Buku Besar', description: 'Mutasi per akun.', href: '/keuangan/buku-besar', permission: 'finance.journal.create', section: 'laporan', icon: 'buku-besar', tile: false },
  { key: 'neraca-saldo', label: 'Neraca Saldo', description: 'Saldo semua akun.', href: '/keuangan/neraca-saldo', permission: 'finance.journal.create', section: 'laporan', icon: 'neraca-saldo', tile: false },
  { key: 'laba-rugi', label: 'Laba Rugi', description: 'Pendapatan, HPP, dan laba kotor.', href: '/keuangan/laba-rugi', permission: 'finance.journal.create', section: 'laporan', icon: 'laporan', tile: false },
  { key: 'neraca', label: 'Neraca', description: 'Aset, kewajiban, dan ekuitas.', href: '/keuangan/neraca', permission: 'finance.journal.create', section: 'laporan', icon: 'neraca', tile: false },
  { key: 'pengecualian-posting', label: 'Pengecualian Posting', description: 'Kejadian yang belum bisa dijurnal.', href: '/keuangan/pengecualian-posting', permission: 'finance.journal.create', section: 'keuangan', icon: 'pengecualian', tile: false },
  { key: 'periode', label: 'Periode', description: 'Tutup dan buka periode akuntansi.', href: '/keuangan/periode', permission: 'finance.close.manage', section: 'keuangan', icon: 'periode', tile: false },
];

/** The screens a viewer holding `permissions` may open, in registry order. */
export function screensFor(permissions: ReadonlySet<string>): WorkScreen[] {
  return workScreens.filter((screen) => screen.permission === null || permissions.has(screen.permission));
}
