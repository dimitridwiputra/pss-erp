import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const state of ['default', 'loading', 'disabled', 'error']) {
  test(`selection cards in ${state} state have no accessibility violations`, async ({ page }) => {
    await page.goto(`/iframe.html?id=fondasi-kartu-pilihan--${state}&viewMode=story`);
    await expect(page.getByRole('group', { name: 'Kondisi barang' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('#storybook-root')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('selection cards support pointer and keyboard choice', async ({ page }) => {
  await page.goto('/iframe.html?id=fondasi-kartu-pilihan--default&viewMode=story');
  const good = page.getByRole('radio', { name: /Baik/ });
  const damaged = page.getByRole('radio', { name: /Rusak/ });
  await page.getByText('Baik', { exact: true }).click();
  await expect(good).toBeChecked();
  await good.focus();
  await page.keyboard.press('ArrowDown');
  await expect(damaged).toBeChecked();
});

test('unavailable selection cards cannot change value', async ({ page }) => {
  await page.goto('/iframe.html?id=fondasi-kartu-pilihan--disabled&viewMode=story');
  const good = page.getByRole('radio', { name: /Baik/ });
  await expect(good).toBeDisabled();
  await expect(good).not.toBeChecked();
});
