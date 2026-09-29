import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: { include: [
    'apps/api/tests/**/*.test.ts',
    'domains/audit/tests/**/*.integration.test.ts',
    'domains/platform/tests/**/*.integration.test.ts',
    'domains/master-data/tests/**/*.integration.test.ts',
    'domains/commercial/tests/**/*.integration.test.ts',
    'domains/inventory/tests/**/*.integration.test.ts',
    'domains/orders/tests/**/*.integration.test.ts',
    'domains/fulfillment/tests/**/*.integration.test.ts',
    'domains/invoicing/tests/**/*.integration.test.ts',
    'domains/payments/tests/**/*.integration.test.ts',
    'domains/pos/tests/**/*.integration.test.ts',
    'domains/reporting/tests/**/*.integration.test.ts',
    'domains/wms/tests/**/*.integration.test.ts',
    'tests/integration/**/*.integration.test.ts',
  ] },
});
