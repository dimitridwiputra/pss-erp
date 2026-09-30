import { expect, test } from '@playwright/test';

test('the counter shows an offline banner promptly without blocking the page', async ({ page, context }) => {
  const hydrationErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('Hydration failed')) hydrationErrors.push(error.message);
  });
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Buka Shift' })).toBeVisible();
  const disconnectedAt = Date.now();
  await context.setOffline(true);
  await expect(page.getByText(/Offline · \d+ transaksi menunggu dikirim/)).toBeVisible({ timeout: 2_000 });
  expect(Date.now() - disconnectedAt).toBeLessThan(2_000);
  await expect(page.getByRole('textbox', { name: 'Scan barang' })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});
