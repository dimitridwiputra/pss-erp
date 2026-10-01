import { expect, test } from '@playwright/test';

test('mobile POS preview completes a sample order without creating a real document', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/pos-preview');
  // The first route visit in next dev can paint server HTML before its click handlers hydrate.
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Buat Pesanan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pilih Pelanggan' })).toBeVisible();
  await page.getByRole('button', { name: /Toko Sumber Jaya OUT-00123/ }).click();
  await page.getByRole('button', { name: 'Tambah Mi Goreng 80g' }).first().click();
  await page.getByRole('button', { name: /Lihat Keranjang/ }).click();
  await expect(page.getByRole('heading', { name: 'Keranjang Pesanan', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Lanjut ke Pembayaran' }).click();
  await page.getByRole('button', { name: 'Rp 50.000' }).click();
  await expect(page.getByText('Rp 47.500')).toBeVisible();
  await page.getByRole('button', { name: 'Lihat Hasil Simulasi' }).click();

  await expect(page.getByRole('heading', { name: 'Hasil Simulasi' })).toBeVisible();
  await expect(page.getByText('Tidak ada pesanan atau dokumen yang dibuat.')).toBeVisible();
});

test('customer needing review cannot start a mobile sample order', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/pos-preview');

  await page.getByRole('button', { name: 'Buat Pesanan', exact: true }).click();
  await page.getByRole('button', { name: /Toko Maju Bersama OUT-00127/ }).click();

  await expect(page.getByRole('heading', { name: 'Pilih Pelanggan' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Pelanggan ini perlu ditinjau');
});
