import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pss\/contracts$/, replacement: fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)) },
      { find: /^@pss\/audit$/, replacement: fileURLToPath(new URL('./domains/audit/src/index.ts', import.meta.url)) },
      { find: /^@pss\/http$/, replacement: fileURLToPath(new URL('./packages/http/src/index.ts', import.meta.url)) },
      { find: /^@pss\/auth-client$/, replacement: fileURLToPath(new URL('./packages/auth-client/src/index.ts', import.meta.url)) },
      { find: /^@pss\/identity$/, replacement: fileURLToPath(new URL('./domains/identity/src/index.ts', import.meta.url)) },
      { find: /^@pss\/platform$/, replacement: fileURLToPath(new URL('./domains/platform/src/index.ts', import.meta.url)) },
      { find: /^@pss\/finance$/, replacement: fileURLToPath(new URL('./domains/finance/src/index.ts', import.meta.url)) },
      { find: /^@pss\/master-data$/, replacement: fileURLToPath(new URL('./domains/master-data/src/index.ts', import.meta.url)) },
      { find: /^@pss\/commercial$/, replacement: fileURLToPath(new URL('./domains/commercial/src/index.ts', import.meta.url)) },
      { find: /^@pss\/inventory$/, replacement: fileURLToPath(new URL('./domains/inventory/src/index.ts', import.meta.url)) },
      { find: /^@pss\/orders$/, replacement: fileURLToPath(new URL('./domains/orders/src/index.ts', import.meta.url)) },
      { find: /^@pss\/fulfillment$/, replacement: fileURLToPath(new URL('./domains/fulfillment/src/index.ts', import.meta.url)) },
      { find: /^@pss\/invoicing$/, replacement: fileURLToPath(new URL('./domains/invoicing/src/index.ts', import.meta.url)) },
      { find: /^@pss\/payments$/, replacement: fileURLToPath(new URL('./domains/payments/src/index.ts', import.meta.url)) },
      { find: /^@pss\/pos$/, replacement: fileURLToPath(new URL('./domains/pos/src/index.ts', import.meta.url)) },
      { find: /^@pss\/reporting$/, replacement: fileURLToPath(new URL('./domains/reporting/src/index.ts', import.meta.url)) },
      { find: /^@pss\/tax$/, replacement: fileURLToPath(new URL('./domains/tax/src/index.ts', import.meta.url)) },
      { find: /^@pss\/wms$/, replacement: fileURLToPath(new URL('./domains/wms/src/index.ts', import.meta.url)) },
    ],
  },
  // `domains/tax/tests/*.test.ts` is scoped by an exclude, not by naming the unit file: this
  // workspace's unit config collects `*.test.ts`, which would otherwise also pull in
  // `*.integration.test.ts` and run it here without a database. Those files are collected by
  // vitest.integration.config.ts instead.
  test: {
    include: [
      'tests/*.test.ts',
      'apps/finance-api/tests/**/*.test.ts',
      'packages/auth-client/tests/**/*.test.ts',
      'packages/configuration/tests/**/*.test.ts',
      'domains/identity/tests/**/*.test.ts',
      'domains/principal-policy/tests/**/*.test.ts',
      'domains/finance/tests/**/*.test.ts',
      'domains/tax/tests/**/*.test.ts',
    ],
    exclude: ['**/*.integration.test.ts'],
  },
});
