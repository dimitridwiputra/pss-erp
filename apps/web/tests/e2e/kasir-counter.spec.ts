import { expect, test } from '@playwright/test';
import { mockKasirApi } from './kasir.fixture';

test('the cashier opens a shift, scans, takes cash with change shown, and gets a receipt', async ({ page }) => {
  const mock = await mockKasirApi(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/kasir');

  await expect(page.getByRole('heading', { name: 'Buka Shift' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Serah Barang' })).toHaveCount(0);
  await page.getByRole('button', { name: /Konter 1/ }).click();
  await page.getByLabel('Modal laci').fill('500.000');
  await page.getByRole('button', { name: 'Buka Shift' }).click();

  const scan = page.getByRole('textbox', { name: 'Scan barang' });
  await expect(scan).toBeFocused();
  await scan.fill('0000000000000');
  await scan.press('Enter');
  await expect(page.locator('.pos-callout-danger')).toContainText('Barang tidak ditemukan');

  await scan.fill('8990001000012');
  await scan.press('Enter');
  await expect(page.getByText('Mi Goreng 80g')).toBeVisible();
  const scannedAt = Date.now();
  // POS-003: the same barcode read again within 500 ms is a scanner double-read, one scan.
  await scan.fill('8990001000012');
  await scan.press('Enter');
  await expect(page.locator('.pos-total-final')).toContainText('Rp 118.000');
  await page.waitForTimeout(Math.max(0, 600 - (Date.now() - scannedAt)));
  await scan.fill('8990001000012');
  await scan.press('Enter');
  await expect(page.locator('.pos-total-final')).toContainText('Rp 236.000');

  await page.getByRole('button', { name: /Bayar/ }).click();
  await expect(page.getByRole('heading', { name: 'Terima Uang' })).toBeVisible();
  await page.getByLabel('Uang diterima').fill('200000');
  await expect(page.getByText(/Uang kurang Rp\s36\.000/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Terima Uang/ })).toBeDisabled();
  await page.getByLabel('Uang diterima').fill('250000');
  await expect(page.locator('.pos-change')).toContainText('Rp 14.000');
  await page.getByRole('button', { name: /Terima Uang/ }).click();

  await expect(page.getByRole('heading', { name: 'Pembayaran diterima' })).toBeVisible();
  const receipt = page.getByRole('article', { name: 'Struk' });
  await expect(receipt).toContainText('INV-DMO-2026-000001');
  await expect(receipt).not.toContainText('SALINAN');

  // PLT-006: every mutation carried a key, and the one sale was created once.
  const mutations = mock.requests.filter((request) => request.method !== 'GET');
  expect(mutations.every((request) => request.idempotencyKey)).toBe(true);
  expect(mutations.filter((request) => request.path === '/pos/sales')).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

test('the cashier view is absent for someone who may only hand over goods', async ({ page }) => {
  await mockKasirApi(page, { canCount: false, canPickup: true });
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: /Menunggu Diambil/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kasir', exact: true })).toHaveCount(0);
  await expect(page.getByText('Tidak ada barang menunggu')).toBeVisible();
});

test('the counter says so when the demo switch is off', async ({ page }) => {
  await mockKasirApi(page, { disabled: true });
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Fitur belum aktif' })).toBeVisible();
});

test('the counter asks to sign in again when the session has ended', async ({ page }) => {
  await mockKasirApi(page, { signedOut: true });
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Silakan masuk' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Masuk' })).toHaveAttribute('href', '/masuk');
});
