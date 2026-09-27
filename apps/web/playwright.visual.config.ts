import { defineConfig, devices } from '@playwright/test';

if (process.platform !== 'linux' && !process.env.PW_TEST_CONNECT_WS_ENDPOINT) {
  throw new Error('Visual snapshots use Linux Chromium. Set PW_TEST_CONNECT_WS_ENDPOINT to the pinned Playwright Docker browser server.');
}

export default defineConfig({
  testDir: './tests/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PSS_VISUAL_BASE_URL ?? 'http://127.0.0.1:6006',
  },
  workers: 1,
  webServer: {
    command: 'pnpm storybook --ci',
    url: 'http://127.0.0.1:6006/index.json',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
