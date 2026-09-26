import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: { include: ['apps/api/tests/**/*.test.ts', 'domains/audit/tests/**/*.integration.test.ts', 'domains/platform/tests/**/*.integration.test.ts', 'tests/integration/**/*.integration.test.ts'] },
});
