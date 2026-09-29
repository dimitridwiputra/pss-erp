import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3000' },
  workers: 1,
});
