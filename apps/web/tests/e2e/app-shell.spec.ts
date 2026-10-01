import { expect, test, type Page } from '@playwright/test';
import { adminShell, financeShell, mockShell, snapshot } from './shell.fixture';

/** The app shell (app/_shell, @pss/ui AppShell) around /kantor, against a stand-in BFF. */
const uuid = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

async function mockCounterBackoffice(page: Page) {
  const names = ['Kasir Demo', 'Rina Kasir', 'Kasir Demo', 'Budi Kasir', 'Rina Kasir', 'Kasir Demo'];
  const statuses = ['HANDED_OVER', 'PAID', 'HANDED_OVER', 'HANDED_OVER', 'PAID', 'HANDED_OVER'];
  await page.route('**/api/bff/core/pos/reports/sales?*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    page: 1, pageSize: 25, total: names.length,
    items: names.map((name, index) => ({
      saleId: uuid(index + 1), invoiceNumber: `INV-DMO-2026-00000${index + 1}`, status: statuses[index], total: `${(index + 1) * 118000}.00`,
      checkedOutAt: `2026-10-01T0${index + 1}:00:00.000Z`, paidAt: `2026-10-01T0${index + 1}:01:00.000Z`, handedOverAt: null,
      shiftId: uuid(90), cashierUserId: uuid(80 + index), cashierName: name, terminalCode: 'KSR-01', terminalName: index % 2 ? 'Konter 2' : 'Konter 1',
    })),
  }) }));
  await page.route('**/api/bff/core/pos/reports/summary?*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    businessDate: '2026-10-01', salesTotal: '2478000.00', saleCount: 6, undepositedCash: '826000.00', undepositedPaymentCount: 3,
  }) }));
}

test('the shell lists only the permitted screens, marks the current one, and jumps with Ctrl+K', async ({ page }) => {
  await mockShell(page);
  await mockCounterBackoffice(page);
  await page.goto('/kantor/penjualan');

  const nav = page.getByRole('navigation', { name: 'Menu' });
  await expect(nav.getByRole('link')).toHaveText(['Beranda', 'Penjualan Konter', 'Setoran Kas']);
  await expect(nav.getByRole('link', { name: 'Penjualan Konter' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByText('Keuangan')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Admin Demo/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Rp 708.000' })).toBeVisible();
  await snapshot(page, 'kantor-penjualan-light');

  await page.keyboard.press('Control+k');
  const jump = page.getByRole('dialog', { name: 'Cari menu' });
  await jump.getByRole('textbox').fill('setor');
  await expect(jump.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/kantor\/setoran-kas$/);
  await expect(nav.getByRole('link', { name: 'Setoran Kas' })).toHaveAttribute('aria-current', 'page');
});

test('dark theme is chosen from the account menu and survives a reload', async ({ page }) => {
  await mockShell(page);
  await mockCounterBackoffice(page);
  await page.goto('/kantor/penjualan');
  await page.getByRole('button', { name: /Admin Demo/ }).click();
  await page.getByRole('menuitemradio', { name: 'Gelap' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('cell', { name: 'Rp 708.000' })).toBeVisible();
  await snapshot(page, 'kantor-penjualan-dark');
  const background = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).toBe('rgb(11, 17, 32)');
});

test('the sidebar collapses to icons, and on a phone it is a drawer', async ({ page }) => {
  await mockShell(page);
  await mockCounterBackoffice(page);
  await page.goto('/kantor/penjualan');
  await page.getByRole('button', { name: 'Ciutkan menu' }).click();
  await expect(page.locator('.pss-app')).toHaveClass(/pss-app-collapsed/);
  await page.reload();
  await expect(page.locator('.pss-app')).toHaveClass(/pss-app-collapsed/);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('navigation', { name: 'Menu' })).not.toBeInViewport();
  await page.getByRole('button', { name: 'Buka menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).toBeInViewport();
  await snapshot(page, 'kantor-penjualan-phone-drawer');
  await page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Setoran Kas' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu' })).not.toBeInViewport();
});

test('a failed menu read says so instead of pretending the viewer has no screens', async ({ page }) => {
  await mockShell(page, { ...adminShell, sections: [adminShell.sections[0]!], incomplete: true });
  await mockCounterBackoffice(page);
  await page.goto('/kantor/penjualan');
  await expect(page.getByText('Sebagian menu belum terbaca')).toBeVisible();
});

test('the shared shell lists finance screens from the permission-scoped view', async ({ page }) => {
  await mockShell(page, financeShell);
  await page.goto('/kantor/penjualan');
  const nav = page.getByRole('navigation', { name: 'Menu' });
  await expect(nav.getByRole('link', { name: 'Dasbor Keuangan' })).toHaveAttribute('href', '/keuangan');
  await expect(nav.getByRole('link', { name: 'Neraca Saldo' })).toHaveAttribute('href', '/keuangan/neraca-saldo');
  await expect(nav.getByRole('link', { name: 'Neraca', exact: true })).toHaveAttribute('href', '/keuangan/neraca');
});
