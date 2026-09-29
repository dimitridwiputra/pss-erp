import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.e2e.config';

/**
 * APR-002 browser suite (`pnpm test:e2e:ci`-style run limited to the approval specs).
 *
 * `playwright.e2e.config.ts` also drives the POS and offline specs, so this config selects
 * only the approval experience specs. It expects the same local stack as
 * `test:e2e:local`: PostgreSQL, Redis, Keycloak, `@pss/api` on 4000 and `@pss/web` on 3000.
 *
 * Add the matching `testIgnore` to `playwright.ci.config.ts` when that gate should keep the
 * approval specs out of CI; until then they self-skip when the local demo account is absent.
 */
export default defineConfig({
  ...baseConfig,
  testMatch: '**/approval-inbox.spec.ts',
  use: {
    ...baseConfig.use,
    ...devices['Desktop Chrome'],
    baseURL: process.env.PSS_WEB_BASE_URL ?? 'http://localhost:3000',
  },
});
