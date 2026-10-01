import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  // Bounded concurrency, because the suite was silently depending on how many files it happens to
  // contain.
  //
  // Every integration fixture creates its own temporary database and opens a pool of up to 20
  // connections against a PostgreSQL configured with `max_connections = 100`. Vitest's default
  // file-level parallelism is well above that, so the suite exhausted the connection limit and
  // failed with `terminating connection due to administrator command` — a connection-limit symptom
  // reported as three unrelated test failures in domains nothing had touched. It passed at 30 test
  // files and failed at 34, which means the suite was one new file away from being red for reasons
  // that had nothing to do with any of them.
  //
  // Four workers is what the suite is verified green at. The alternative — raising
  // max_connections in the test container — treats the symptom and leaves the real property
  // unstated: the suite's cost is bounded by the database it runs against, not by luck.
  maxWorkers: 4,
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
    'domains/finance/tests/**/*.integration.test.ts',
    'domains/tax/tests/**/*.integration.test.ts',
    'domains/wms/tests/**/*.integration.test.ts',
    'tests/integration/**/*.integration.test.ts',
  ] },
});
