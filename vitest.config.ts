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
    ],
  },
  test: { include: ['tests/*.test.ts', 'packages/auth-client/tests/**/*.test.ts'] },
});
