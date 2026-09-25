import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pss\/contracts$/, replacement: fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)) },
      { find: /^@pss\/http$/, replacement: fileURLToPath(new URL('./packages/http/src/index.ts', import.meta.url)) },
    ],
  },
  test: { include: ['tests/**/*.test.ts', 'apps/api/tests/**/*.test.ts'] },
});
