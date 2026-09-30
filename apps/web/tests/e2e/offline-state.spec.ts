import { expect, test } from '@playwright/test';
import { mockKasirApi } from './kasir.fixture';

test('the counter shows an offline notice promptly without breaking the page', async ({ page, context }) => {
  const hydrationErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('Hydration failed')) hydrationErrors.push(error.message);
  });
  await mockKasirApi(page);
  await page.goto('/kasir');
  await expect(page.getByRole('heading', { name: 'Buka Shift' })).toBeVisible();
  const disconnectedAt = Date.now();
  await context.setOffline(true);
  // The MVP counter records every sale on the server (offline mode is out of scope), so the notice
  // says selling waits for the connection rather than counting a queue that does not exist.
  await expect(page.getByText('Offline · Kasir perlu internet untuk mencatat penjualan')).toBeVisible({ timeout: 2_000 });
  expect(Date.now() - disconnectedAt).toBeLessThan(2_000);
  await expect(page.getByRole('heading', { name: 'Buka Shift' })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});
