import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.e2e.config';

// `pnpm test:e2e` is the CI gate, so it must execute real browser coverage and be
// able to fail. The browser sign-in suite is excluded here because it needs the
// local Keycloak realm and the demo credentials written by `pnpm dev:up`; it
// stays in `pnpm test:e2e:local`. The POS preview route is deliberately
// development-only (`notFound()` unless NODE_ENV is development), so this gate
// drives `next dev` rather than a production server.
//
// The gate uses its own port and never reuses an existing server. Reusing one
// lets a back-to-back run attach to the previous run's still-terminating
// `next dev`, which fails intermittently and makes the gate untrustworthy.
export default defineConfig({
  ...baseConfig,
  // local-login needs the local Keycloak realm and the demo credentials written by
  // `pnpm dev:up`; it stays in `pnpm test:e2e:local`. approval-inbox needs the same
  // demo account plus a seeded approval, so it is skipped here too and runs under
  // `pnpm test:e2e:experience` / `test:e2e:local`. The POS preview route is
  // deliberately development-only (`notFound()` unless NODE_ENV is development), so
  // this gate drives `next dev` rather than a production server.
  testIgnore: ['**/local-login.spec.ts', '**/approval-inbox.spec.ts'],
  use: { ...baseConfig.use, ...devices['Desktop Chrome'], baseURL: 'http://localhost:3100' },
  webServer: {
    command: 'pnpm exec next dev --webpack -p 3100',
    url: 'http://localhost:3100/kasir',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
