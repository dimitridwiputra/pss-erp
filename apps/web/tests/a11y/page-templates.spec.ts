import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const emptyTemplateStories = [
  'template-a-tugas-mobile--default',
  'template-b-antrian-desktop--default',
  'template-c-control-station--default',
  'template-d-tutup-buku--default',
];

for (const storyId of emptyTemplateStories) {
  test(`${storyId} has no WCAG 2.2 AA or axe best-practice violations`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
    await expect(page.locator('#storybook-root main')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('#storybook-root')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
