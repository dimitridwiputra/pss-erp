import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const stories = [
  'fondasi-status',
  'fondasi-scan',
  'fondasi-pengecualian',
  'fondasi-konfirmasi',
  'fondasi-toast',
  'fondasi-tabel',
  'fondasi-keadaan-halaman',
];

for (const story of stories) {
  for (const state of ['default', 'loading', 'disabled', 'error']) {
    test(`${story} ${state} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.goto(`/iframe.html?id=${story}--${state}&viewMode=story`);
      await expect(page.locator('#storybook-root')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include('#storybook-root')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('standard error keeps the support request ID in details', async ({ page }) => {
  await page.goto('/iframe.html?id=fondasi-keadaan-halaman--error&viewMode=story');
  await expect(page.getByText('Data sudah berubah')).toBeVisible();
  await expect(page.getByText('Kode bantuan: req-demo')).toBeHidden();
  await page.getByText('Rincian untuk bantuan').click();
  await expect(page.getByText('Kode bantuan: req-demo')).toBeVisible();
});
