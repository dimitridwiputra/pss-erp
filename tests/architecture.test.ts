import { describe, expect, it } from 'vitest';
import { findArchitectureViolations } from '../scripts/check-architecture.mjs';

const root = '/work/pss-erp';

describe('PLT-002 import boundaries', () => {
  it('rejects a domain importing another domain internals', () => {
    const violations = findArchitectureViolations([{
      path: `${root}/domains/sfa/application/submit.ts`,
      source: "import { Order } from '../../orders/domain/order';",
    }]);
    expect(violations).toEqual([expect.stringContaining('cross-domain internals')]);
  });

  it('rejects package-to-domain and BFF-to-database imports', () => {
    const violations = findArchitectureViolations([
      { path: `${root}/packages/contracts/src/index.ts`, source: "export { Order } from '../../../domains/orders/domain/order';" },
      { path: `${root}/apps/web/app/page.tsx`, source: "import { PrismaClient } from '@prisma/client';" },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('packages cannot import domains');
    expect(violations[1]).toContain('cannot access a database');
  });

  it('accepts a shared contract import', () => {
    expect(findArchitectureViolations([{
      path: `${root}/domains/sfa/application/submit.ts`,
      source: "import { EventNameSchema } from '@pss/contracts';",
    }])).toEqual([]);
  });
});
