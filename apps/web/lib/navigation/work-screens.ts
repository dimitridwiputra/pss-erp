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
];

/** The screens a viewer holding `permissions` may open, in registry order. */
export function screensFor(permissions: ReadonlySet<string>): WorkScreen[] {
  return workScreens.filter((screen) => screen.permission === null || permissions.has(screen.permission));
}
