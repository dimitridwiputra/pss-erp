import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/a11y',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:6006' },
  workers: 1,
  webServer: {
    command: 'pnpm storybook --ci',
    url: 'http://127.0.0.1:6006/index.json',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
