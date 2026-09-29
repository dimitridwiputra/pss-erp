import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.e2e.config';

// `pnpm test:e2e` is the CI gate, so it must execute real browser coverage and be
// able to fail. The browser sign-in suite is excluded here because it needs the
// local Keycloak realm and the demo credentials written by `pnpm dev:up`; it
// stays in `pnpm test:e2e:local`. The POS preview route is deliberately
// development-only (`notFound()` unless NODE_ENV is development), so this gate
// drives `next dev` rather than a production server.
export default defineConfig({
  ...baseConfig,
  testIgnore: '**/local-login.spec.ts',
  use: { ...baseConfig.use, ...devices['Desktop Chrome'], baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000/kasir',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
