import type { ExperienceShellView } from '@pss/contracts';
import type { Page } from '@playwright/test';

/** The navigation /api/experience/shell would give admin.demo (MVP_PLAN §7), for CI without Keycloak. */
export const adminShell: ExperienceShellView = {
  view: 'shell',
  version: 1,
  viewer: { displayName: 'Admin Demo' },
  sections: [
    { key: 'hari-ini', label: 'Hari Ini', items: [{ key: 'beranda', label: 'Beranda', description: 'Ringkasan hari ini dan pekerjaan Anda.', href: '/beranda', icon: 'home' }] },
    { key: 'penjualan', label: 'Penjualan', items: [{ key: 'penjualan', label: 'Penjualan Konter', description: 'Lihat transaksi kasir dan fakturnya.', href: '/kantor/penjualan', icon: 'penjualan' }] },
    { key: 'kas', label: 'Kas', items: [{ key: 'setoran-kas', label: 'Setoran Kas', description: 'Hitung dan terima uang dari kasir.', href: '/kantor/setoran-kas', icon: 'setoran-kas' }] },
  ],
  incomplete: false,
};

export const financeShell: ExperienceShellView = {
  ...adminShell,
  viewer: { displayName: 'Keuangan Demo' },
  sections: [adminShell.sections[0]!, {
    key: 'keuangan', label: 'Keuangan', items: [
      { key: 'keuangan', label: 'Dasbor Keuangan', description: 'Periksa periode, jurnal, dan laba kotor.', href: '/keuangan', icon: 'dasbor' },
      { key: 'jurnal', label: 'Jurnal', description: 'Telusuri jurnal dan dokumen sumbernya.', href: '/keuangan/jurnal', icon: 'jurnal' },
      { key: 'jurnal-manual', label: 'Jurnal Manual', description: 'Siapkan jurnal untuk persetujuan.', href: '/keuangan/jurnal-manual', icon: 'jurnal' },
      { key: 'buku-besar', label: 'Buku Besar', description: 'Telusuri mutasi akun.', href: '/keuangan/buku-besar', icon: 'buku-besar' },
      { key: 'neraca-saldo', label: 'Neraca Saldo', description: 'Periksa keseimbangan buku.', href: '/keuangan/neraca-saldo', icon: 'neraca-saldo' },
      { key: 'laba-rugi', label: 'Laba Rugi', description: 'Lihat hasil usaha periode ini.', href: '/keuangan/laba-rugi', icon: 'laporan' },
      { key: 'neraca', label: 'Neraca', description: 'Lihat posisi keuangan.', href: '/keuangan/neraca', icon: 'neraca' },
      { key: 'pengecualian-posting', label: 'Pengecualian Posting', description: 'Tindak lanjuti transaksi yang belum dibukukan.', href: '/keuangan/pengecualian-posting', icon: 'pengecualian' },
      { key: 'periode', label: 'Periode', description: 'Kelola penutupan buku.', href: '/keuangan/periode', icon: 'periode' },
    ],
  }],
};

export async function mockShell(page: Page, view: ExperienceShellView = adminShell) {
  await page.route('**/api/experience/shell', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }));
}

/** Saves a screenshot only when PSS_SCREENSHOT_DIR is set (manual visual review); CI never writes files. */
export async function snapshot(page: Page, name: string) {
  const dir = process.env.PSS_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(300); // let the drawer's slide finish
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
