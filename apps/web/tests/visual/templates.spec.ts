import { expect, test } from '@playwright/test';

const templates = [
  { id: 'template-a-tugas-mobile', width: 390, height: 844 },
  { id: 'template-b-antrian-desktop', width: 1280, height: 800 },
  { id: 'template-c-control-station', width: 1280, height: 800 },
  { id: 'template-d-tutup-buku', width: 1280, height: 800 },
] as const;

for (const template of templates) {
  for (const state of ['default', 'error'] as const) {
    test(`UX-001.TS02 ${template.id} ${state} matches its reviewed snapshot`, async ({ page }) => {
      await page.setViewportSize({ width: template.width, height: template.height });
      await page.goto(`/iframe.html?id=${template.id}--${state}&viewMode=story`);
      const root = page.locator('#storybook-root');
      await expect(root.locator('main')).toBeVisible();
      await expect(root).toHaveScreenshot(`${template.id}-${state}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.005,
      });
    });
  }
}
