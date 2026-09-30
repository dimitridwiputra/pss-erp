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
